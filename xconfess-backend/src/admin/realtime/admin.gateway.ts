import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { UserService } from '../../user/user.service';
import { Logger, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '../../user/entities/user.entity';
import { WsJwtGuard } from '../../auth/guards/ws-jwt.guard';
import { WsRolesGuard } from '../../auth/guards/ws-roles.guard';
import { WsRoles } from '../../auth/decorators/ws-roles.decorator';
import { WebSocketLogger } from '../../websocket/websocket.logger';
import { JwtPayload } from '../../auth/interfaces/jwt-payload.interface';

const ADMIN_ROOM = 'admin:events';

interface SocketAuthPayload {
  token?: string;
}

interface AdminSocketJwtPayload extends Partial<JwtPayload> {
  userId?: number | string;
}

interface AdminSocketData {
  userId?: number;
  user?: { id: number; role: UserRole };
}

/**
 * CORS origin is intentionally omitted from the decorator — it is supplied at
 * the adapter level (WebSocketAdapter) from the FRONTEND_URL env variable.
 * Hardcoding origin: '*' here would bypass that policy for the admin namespace.
 */
@WebSocketGateway({ namespace: 'admin' })
export class AdminGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(AdminGateway.name);
  private readonly userSockets = new Map<number, Set<string>>();

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly userService: UserService,
    private readonly wsLogger: WebSocketLogger,
    private readonly configService: ConfigService,
  ) {}

  private extractSocketToken(client: Socket): string | null {
    const auth = client.handshake.auth as SocketAuthPayload | undefined;
    if (typeof auth?.token === 'string' && auth.token.length > 0) {
      return auth.token;
    }

    const authorizationHeader = client.handshake.headers.authorization;
    if (typeof authorizationHeader !== 'string') return null;

    const token = authorizationHeader.replace(/^Bearer\s+/i, '');
    return token.length > 0 ? token : null;
  }

  private resolveJwtUserId(payload: AdminSocketJwtPayload): number | null {
    const candidate = payload.sub ?? payload.userId;
    if (candidate === undefined || candidate === null || candidate === '')
      return null;

    if (typeof candidate === 'string' && !/^\d+$/.test(candidate)) return null;
    const userId = Number(candidate);

    return Number.isSafeInteger(userId) && userId > 0 ? userId : null;
  }

  private getSocketData(client: Socket): AdminSocketData {
    return client.data as unknown as AdminSocketData;
  }

  async handleConnection(@ConnectedSocket() client: Socket) {
    try {
      const token = this.extractSocketToken(client);

      if (!token) {
        this.wsLogger.logSubscriptionRejected({
          socketId: client.id,
          channel: ADMIN_ROOM,
          reason: 'No authentication token provided',
        });
        client.disconnect(true);
        return;
      }

      const payload = this.jwtService.verify<AdminSocketJwtPayload>(token);
      const userId = this.resolveJwtUserId(payload);

      if (userId === null) {
        this.wsLogger.logSubscriptionRejected({
          socketId: client.id,
          channel: ADMIN_ROOM,
          reason: 'Invalid token payload — userId could not be resolved',
        });
        client.disconnect(true);
        return;
      }

      const user = await this.userService.findById(userId);
      if (user?.role !== UserRole.ADMIN || user.is_active !== true) {
        this.wsLogger.logSubscriptionRejected({
          socketId: client.id,
          userId,
          channel: ADMIN_ROOM,
          reason: `Inactive account or insufficient role — got '${user?.role ?? 'none'}', required active '${UserRole.ADMIN}'`,
        });
        client.disconnect(true);
        return;
      }

      const socketData = this.getSocketData(client);
      socketData.userId = userId;
      socketData.user = { id: userId, role: user.role };
      client.data.wsAuthToken = token;
      this.trackSocket(userId, client.id);

      await client.join(ADMIN_ROOM);

      this.wsLogger.logSubscriptionGranted({
        socketId: client.id,
        userId,
        channel: ADMIN_ROOM,
      });
      this.logger.log(`Admin connected: ${userId} (${client.id})`);
    } catch (e) {
      this.wsLogger.logSubscriptionRejected({
        socketId: client.id,
        channel: ADMIN_ROOM,
        reason: e instanceof Error ? e.message : 'unknown auth error',
      });
      this.logger.warn(
        `Admin socket auth failed (${client.id}): ${e instanceof Error ? e.message : 'unknown'}`,
      );
      client.disconnect(true);
    }
  }

  handleDisconnect(@ConnectedSocket() client: Socket) {
    const socketData = this.getSocketData(client);
    if (socketData.userId !== undefined) {
      this.untrackSocket(socketData.userId, client.id);
    }
    this.logger.log(
      `Admin disconnected: ${socketData.userId ?? 'unknown'} (${client.id})`,
    );
  }

  @SubscribeMessage('auth:refresh')
  async handleAuthRefresh(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: SocketAuthPayload,
  ) {
    const token = payload?.token;
    if (!token || typeof token !== 'string') {
      client.emit('auth:rejected', {
        reason: 'NO_TOKEN_PROVIDED',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      const decoded = this.jwtService.verify<AdminSocketJwtPayload>(token);
      const userId = this.resolveJwtUserId(decoded);
      if (userId === null) throw new Error('MISSING_SUBJECT');

      const user = await this.userService.findById(userId);
      if (!user || user.is_active !== true || user.role !== UserRole.ADMIN) {
        throw new Error('SESSION_REVOKED_OR_INSUFFICIENT_ROLE');
      }

      const socketData = this.getSocketData(client);
      if (socketData.userId !== undefined && socketData.userId !== userId) {
        this.untrackSocket(socketData.userId, client.id);
      }
      socketData.userId = userId;
      socketData.user = { id: userId, role: user.role };
      client.data.wsAuthToken = token;
      this.trackSocket(userId, client.id);
      await client.join(ADMIN_ROOM);

      client.emit('auth:refreshed', {
        success: true,
        userId: String(userId),
        timestamp: new Date().toISOString(),
      });
    } catch {
      const currentUserId = this.getSocketData(client).userId;
      if (currentUserId !== undefined) {
        this.untrackSocket(currentUserId, client.id);
      }
      client.emit('auth:revoked', {
        reason: 'SESSION_REVOKED_OR_EXPIRED',
        timestamp: new Date().toISOString(),
      });
      client.disconnect(true);
    }
  }

  revokeUserSessions(userId: number, reason = 'SESSION_REVOKED'): number {
    const socketIds = this.userSockets.get(userId);
    if (!socketIds?.size) return 0;

    let disconnectedCount = 0;
    for (const socketId of Array.from(socketIds)) {
      const socket = this.server?.sockets?.sockets?.get?.(socketId);
      if (!socket) continue;

      socket.emit('auth:revoked', {
        reason,
        timestamp: new Date().toISOString(),
      });
      socket.disconnect(true);
      disconnectedCount++;
    }

    this.userSockets.delete(userId);
    return disconnectedCount;
  }

  private trackSocket(userId: number, socketId: string): void {
    let socketIds = this.userSockets.get(userId);
    if (!socketIds) {
      socketIds = new Set<string>();
      this.userSockets.set(userId, socketIds);
    }
    socketIds.add(socketId);
  }

  private untrackSocket(userId: number, socketId: string): void {
    const socketIds = this.userSockets.get(userId);
    if (!socketIds) return;
    socketIds.delete(socketId);
    if (socketIds.size === 0) this.userSockets.delete(userId);
  }

  @UseGuards(WsJwtGuard, WsRolesGuard)
  @WsRoles(UserRole.ADMIN)
  @SubscribeMessage('subscribe:admin-events')
  handleAdminSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() _data: unknown,
  ) {
    const userId = this.getSocketData(client).userId;
    this.wsLogger.logSubscriptionGranted({
      socketId: client.id,
      userId,
      channel: ADMIN_ROOM,
    });
    client.emit('subscription:confirmed', {
      channel: ADMIN_ROOM,
      timestamp: new Date().toISOString(),
    });
  }

  @UseGuards(WsJwtGuard, WsRolesGuard)
  @WsRoles(UserRole.ADMIN)
  @SubscribeMessage('unsubscribe:admin-events')
  async handleAdminUnsubscribe(@ConnectedSocket() client: Socket) {
    const socketData = this.getSocketData(client);
    await client.leave(ADMIN_ROOM);
    this.logger.log(
      `Admin ${socketData.userId} left ${ADMIN_ROOM} (${client.id})`,
    );
    client.emit('subscription:cancelled', {
      channel: ADMIN_ROOM,
      timestamp: new Date().toISOString(),
    });
  }

  emitNewReport(payload: any) {
    this.server.to(ADMIN_ROOM).emit('new-report', payload);
  }
  emitReportUpdated(payload: any) {
    this.server.to(ADMIN_ROOM).emit('report-updated', payload);
  }
  emitReportsBulkUpdated(payload: any) {
    this.server.to(ADMIN_ROOM).emit('reports-bulk-updated', payload);
  }
}
