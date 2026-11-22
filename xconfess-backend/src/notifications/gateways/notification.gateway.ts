import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WsJwtGuard } from '../../auth/guards/ws-jwt.guard';
import { NotificationService } from '../services/notification.service';
import { User } from '../../user/entities/user.entity';
import { WebSocketLogger } from '../../websocket/websocket.logger';
import {
  assertPayloadSize,
  enforceSocketCap,
} from '../../websocket/ws-memory-guard';
import {
  getSocketSignal,
  isCancelled,
  runWithCancellation,
} from '../../common/cancellation/cancellation';

/** Channel prefix for per-user private rooms */
const USER_ROOM_PREFIX = 'user:';

@WebSocketGateway({
  namespace: '/notifications',
  transports: ['websocket', 'polling'],
})
export class NotificationGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(NotificationGateway.name);
  private userSockets = new Map<string, Set<string>>(); // userId -> Set of socket IDs

  constructor(
    private notificationService: NotificationService,
    private configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly wsLogger: WebSocketLogger,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  afterInit(server: Server) {
    const frontendUrl =
      this.configService.get<string>('FRONTEND_URL') ||
      this.configService.get<string>('app.frontendUrl') ||
      'http://localhost:3000';
    if (server.engine?.opts) {
      server.engine.opts.cors = {
        origin: frontendUrl,
        credentials: true,
      };
    } else {
      this.logger.warn(
        'Socket.IO engine options are unavailable; using gateway CORS defaults',
      );
    }
    if (typeof server.use === 'function') {
      server.use(async (socket, next) => {
        try {
          const token = this.extractHandshakeToken(socket);
          if (!token) {
            return next(new Error('Authentication failed'));
          }

          const payload: any = await this.jwtService.verifyAsync(token);
          const userId = this.normalizeUserId(payload?.sub);
          if (!userId) {
            return next(new Error('Authentication failed'));
          }

          if (!(await this.isActiveUser(userId))) {
            return next(new Error('Authentication failed'));
          }

          socket.data = socket.data || {};
          socket.data.userId = userId;
          socket.data.username = payload.username;
          return next();
        } catch {
          return next(new Error('Authentication failed'));
        }
      });
    }
    this.logger.log('Notification Gateway initialized');
  }

  private extractHandshakeToken(socket: Socket): string | null {
    const auth = socket.handshake?.auth as any;
    if (auth && typeof auth.token === 'string' && auth.token.trim()) {
      return auth.token.trim();
    }

    const authHeader = socket.handshake?.headers?.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      return authHeader.slice('Bearer '.length).trim();
    }

    return null;
  }

  private async isActiveUser(userId: string): Promise<boolean> {
    const numericUserId = Number(userId);
    if (!Number.isSafeInteger(numericUserId) || numericUserId <= 0) return false;

    const user = await this.userRepository.findOne({
      where: { id: numericUserId },
      select: { id: true, is_active: true },
    });
    return user?.is_active === true;
  }

  private normalizeUserId(candidate: unknown): string | null {
    if (
      typeof candidate !== 'number' &&
      (typeof candidate !== 'string' || !/^\d+$/.test(candidate))
    ) {
      return null;
    }

    const numericUserId = Number(candidate);
    if (!Number.isSafeInteger(numericUserId) || numericUserId <= 0) return null;
    return String(numericUserId);
  }

  // ─── Connection lifecycle ─────────────────────────────────────────────────

  handleConnection(client: Socket) {
    const userId = client.data.userId;

    if (!userId) {
      this.wsLogger.logSubscriptionRejected({
        socketId: client.id,
        channel: `${USER_ROOM_PREFIX}<unknown>`,
        reason:
          'No authenticated userId on socket — WsJwtGuard may have been bypassed',
      });
      client.disconnect();
      return;
    }

    // Add socket to user's socket set
    if (!this.userSockets.has(userId)) {
      this.userSockets.set(userId, new Set());
    }
    const sockets = this.userSockets.get(userId);
    if (sockets) {
      sockets.add(client.id);
    }

    // Enforce per-user connection cap to prevent unbounded heap growth
    // from abandoned browser tabs (issue #102).
    enforceSocketCap(userId, client.id, this.userSockets, this.server as any);

    this.logger.log(`Client connected: ${client.id} (User: ${userId})`);

    // Join the user-specific room — scoped fanout enforced here
    const userRoom = `${USER_ROOM_PREFIX}${userId}`;
    client.join(userRoom);

    this.wsLogger.logSubscriptionGranted({
      socketId: client.id,
      userId,
      channel: userRoom,
    });

    void this.emitUnreadSync(client, userId);
  }

  handleDisconnect(client: Socket) {
    const userId = client.data.userId;

    if (userId && this.userSockets.has(userId)) {
      const sockets = this.userSockets.get(userId);
      if (sockets) {
        sockets.delete(client.id);

        if (sockets.size === 0) {
          this.userSockets.delete(userId);
        }
      }
    }

    this.logger.log(`Client disconnected: ${client.id}`);
  }

  // ─── Subscription handlers ────────────────────────────────────────────────

  /**
   * Explicit channel-subscription handler.
   *
   * Clients call this after connecting to confirm they want to receive
   * events for a specific user room. The handler enforces that the
   * requested userId matches the authenticated socket owner, preventing
   * any client from subscribing to another user's private channel.
   */
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('subscribe:user-notifications')
  handleSubscribeUserNotifications(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { userId?: string },
  ) {
    const authenticatedUserId = String(client.data.userId);
    const requestedUserId = data?.userId ? String(data.userId) : null;

    // If the client specifies a userId, it must match their own
    if (requestedUserId && requestedUserId !== authenticatedUserId) {
      this.wsLogger.logSubscriptionRejected({
        socketId: client.id,
        userId: authenticatedUserId,
        channel: `${USER_ROOM_PREFIX}${requestedUserId}`,
        reason: `Ownership violation — authenticated as '${authenticatedUserId}', attempted to subscribe to '${requestedUserId}'`,
      });
      client.emit('subscription:rejected', {
        channel: `${USER_ROOM_PREFIX}${requestedUserId}`,
        reason: 'You can only subscribe to your own notification channel',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const userRoom = `${USER_ROOM_PREFIX}${authenticatedUserId}`;

    // Ensure the socket is in its own room (idempotent — socket.io handles duplicates)
    client.join(userRoom);

    this.wsLogger.logSubscriptionGranted({
      socketId: client.id,
      userId: authenticatedUserId,
      channel: userRoom,
    });

    client.emit('subscription:confirmed', {
      channel: userRoom,
      timestamp: new Date().toISOString(),
    });

    void this.emitUnreadSync(client, authenticatedUserId);
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('join-notifications')
  handleLegacyJoinNotifications(
    @ConnectedSocket() client: Socket,
    @MessageBody() requestedUserId?: string,
  ) {
    this.handleSubscribeUserNotifications(client, { userId: requestedUserId });
  }

  private async emitUnreadSync(client: Socket, userId: string) {
    // Issue #182: the unread-count sync is a database read. When the socket
    // disconnects the signal is aborted and the read is abandoned instead of
    // holding a connection for a result nobody will receive.
    const signal = getSocketSignal(client);

    try {
      const result = await runWithCancellation(
        () =>
          this.notificationService.getUserNotifications(
            userId,
            { page: 1, limit: 20, unreadOnly: true },
          ),
        signal,
      );
      client.emit('notifications:sync', {
        notifications: result.notifications,
        unreadCount: result.unreadCount,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      if (isCancelled(signal)) {
        this.logger.debug(
          `Unread notification sync cancelled — client ${client.id} disconnected`,
        );
        return;
      }
      this.logger.error(
        `Failed to sync unread notification count for user ${userId}`,
        error,
      );
      client.emit('notifications:sync-failed', {
        message: 'Failed to sync unread notifications',
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Unsubscribe from the user-notifications channel.
   * The client leaves their private room but the WS connection stays open.
   */
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('unsubscribe:user-notifications')
  async handleUnsubscribeUserNotifications(@ConnectedSocket() client: Socket) {
    const userId = String(client.data.userId);
    const userRoom = `${USER_ROOM_PREFIX}${userId}`;
    await client.leave(userRoom);

    this.logger.log(`User ${userId} left ${userRoom} (${client.id})`);
    client.emit('subscription:cancelled', {
      channel: userRoom,
      timestamp: new Date().toISOString(),
    });
  }

  // ─── Existing message handlers ────────────────────────────────────────────

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('mark-read')
  async handleMarkRead(client: Socket, payload: { notificationId: string }) {
    const userId = client.data.userId;

    // Guard oversized payloads before any application logic runs (issue #102).
    if (!assertPayloadSize(client, 'mark-read', payload)) return;

    try {
      await this.notificationService.markAsRead(payload.notificationId, userId);

      client.emit('notification-read', {
        notificationId: payload.notificationId,
      });
    } catch (error) {
      this.logger.error(`Error marking notification as read:`, error);
      client.emit('error', { message: 'Failed to mark notification as read' });
    }
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('mark-all-read')
  async handleMarkAllRead(client: Socket) {
    const userId = client.data.userId;

    try {
      await this.notificationService.markAllAsRead(userId);

      client.emit('all-notifications-read', {});
    } catch (error) {
      this.logger.error(`Error marking all notifications as read:`, error);
      client.emit('error', {
        message: 'Failed to mark all notifications as read',
      });
    }
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('get-unread-count')
  async handleGetUnreadCount(client: Socket) {
    const userId = client.data.userId;

    try {
      const { unreadCount } =
        await this.notificationService.getUserNotifications(userId, {
          page: 1,
          limit: 1,
          unreadOnly: true,
        });

      client.emit('unread-count', { count: unreadCount });
    } catch (error) {
      this.logger.error(`Error getting unread count:`, error);
      client.emit('error', { message: 'Failed to get unread count' });
    }
  }

  // ─── Scoped fanout helpers ─────────────────────────────────────────────────
  // All emissions target `user:<userId>` rooms — never broadcast to the full
  // namespace, ensuring strict per-user isolation.

  async sendNotificationToUser(userId: string, notification: any) {
    const shouldDeliver = await this.notificationService.shouldDeliverRealtime(
      userId,
      notification.type,
    );
    if (!shouldDeliver) {
      this.logger.log(
        `Realtime notification suppressed for user ${userId} (preference check)`,
      );
      return;
    }

    const userRoom = `${USER_ROOM_PREFIX}${userId}`;
    this.server.to(userRoom).emit('new-notification', notification);

    // Also send updated unread count
    const { unreadCount } = await this.notificationService.getUserNotifications(
      userId,
      { page: 1, limit: 1, unreadOnly: true },
    );

    this.server.to(userRoom).emit('unread-count', { count: unreadCount });
  }

  isUserOnline(userId: string): boolean {
    const sockets = this.userSockets.get(userId);
    return sockets !== undefined && sockets.size > 0;
  }

  // ─── Reauthentication & Revocation Protocol ───────────────────────────────

  @SubscribeMessage('auth:refresh')
  async handleAuthRefresh(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { token?: string },
  ) {
    const oldUserId = client.data?.userId;
    const token = payload?.token;

    if (!token || typeof token !== 'string') {
      this.logger.warn(`Auth refresh rejected on socket ${client.id}: missing token`);
      client.emit('auth:rejected', {
        reason: 'NO_TOKEN_PROVIDED',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      const decoded: any = await this.jwtService.verifyAsync(token);
      const newUserId = this.normalizeUserId(decoded?.sub);
      if (!newUserId) {
        throw new Error('MISSING_SUBJECT');
      }

      if (!(await this.isActiveUser(newUserId))) {
        throw new Error('INACTIVE_ACCOUNT');
      }

      // If user identity changed during refresh, migrate socket tracking
      if (oldUserId && oldUserId !== newUserId) {
        const oldSet = this.userSockets.get(oldUserId);
        if (oldSet) {
          oldSet.delete(client.id);
          if (oldSet.size === 0) this.userSockets.delete(oldUserId);
        }
        await client.leave(`${USER_ROOM_PREFIX}${oldUserId}`);
      }

      client.data = client.data || {};
      client.data.userId = newUserId;
      client.data.username = decoded.username;
      client.data.wsAuthToken = token;

      // Re-register in user room
      const newRoom = `${USER_ROOM_PREFIX}${newUserId}`;
      await client.join(newRoom);

      if (!this.userSockets.has(newUserId)) {
        this.userSockets.set(newUserId, new Set());
      }
      this.userSockets.get(newUserId)?.add(client.id);

      this.logger.log(`Socket ${client.id} successfully refreshed session for user ${newUserId}`);
      client.emit('auth:refreshed', {
        success: true,
        userId: newUserId,
        timestamp: new Date().toISOString(),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Auth refresh failed on socket ${client.id}: ${message}`);
      if (oldUserId) {
        const oldSet = this.userSockets.get(oldUserId);
        oldSet?.delete(client.id);
        if (oldSet?.size === 0) this.userSockets.delete(oldUserId);
      }
      client.emit('auth:revoked', {
        reason: 'SESSION_REVOKED_OR_EXPIRED',
        timestamp: new Date().toISOString(),
      });
      client.disconnect(true);
    }
  }

  async revokeUserSessions(userId: string, reason = 'SESSION_REVOKED'): Promise<number> {
    const socketIds = this.userSockets.get(userId);
    if (!socketIds || socketIds.size === 0) return 0;

    let disconnectedCount = 0;
    for (const socketId of Array.from(socketIds)) {
      const socket = this.server?.sockets?.sockets?.get?.(socketId);
      if (socket) {
        socket.emit('auth:revoked', {
          reason,
          timestamp: new Date().toISOString(),
        });
        socket.disconnect(true);
        disconnectedCount++;
      }
    }

    this.userSockets.delete(userId);
    this.logger.warn(`Revoked ${disconnectedCount} active websocket sessions for user ${userId} (${reason})`);
    return disconnectedCount;
  }
}

