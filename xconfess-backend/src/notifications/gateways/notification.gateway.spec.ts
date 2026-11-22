jest.mock('../../user/user.service', () => ({
  UserService: class UserService {},
}));

import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtService, TokenExpiredError } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { WsJwtGuard } from '../../auth/guards/ws-jwt.guard';
import { WebSocketLogger } from '../../websocket/websocket.logger';
import { buildWebSocketServerOptions } from '../../websocket/websocket.adapter';
import { NotificationGateway } from './notification.gateway';

describe('Notification websocket auth regression coverage', () => {
  const createSocket = (
    overrides: Partial<Socket> & { data?: Record<string, unknown> } = {},
  ) =>
    ({
      id: 'socket-1',
      data: {},
      handshake: {
        auth: {},
        headers: {},
      },
      emit: jest.fn(),
      join: jest.fn(),
      leave: jest.fn(),
      disconnect: jest.fn(),
      ...overrides,
    }) as unknown as Socket;

  const createWsContext = (client: Socket): ExecutionContext =>
    ({
      switchToWs: () => ({
        getClient: () => client,
      }),
    }) as unknown as ExecutionContext;

  const createGuard = (
    jwtService: Pick<JwtService, 'verifyAsync'>,
    userService?: { findById: jest.Mock },
  ) => new WsJwtGuard(jwtService as JwtService, userService as any);

  const createGateway = () => {
    const notificationService = {
      markAsRead: jest.fn(),
      markAllAsRead: jest.fn(),
      getUserNotifications: jest.fn().mockResolvedValue({
        notifications: [],
        total: 0,
        unreadCount: 0,
      }),
      shouldDeliverRealtime: jest.fn().mockResolvedValue(true),
    };
    const configService = {
      get: jest.fn((_key: string, fallback: unknown) => fallback),
    };
    const wsLogger = {
      logSubscriptionRejected: jest.fn(),
      logSubscriptionGranted: jest.fn(),
    };
    const jwtService = { verifyAsync: jest.fn() };
    const userRepository = {
      findOne: jest.fn().mockResolvedValue({ is_active: true }),
    };

    return {
      gateway: new NotificationGateway(
        notificationService as any,
        configService as any,
        jwtService as any,
        wsLogger as unknown as WebSocketLogger,
        userRepository as any,
      ),
      wsLogger,
      jwtService,
      userRepository,
    };
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('rejects notification sockets when the handshake has no token', async () => {
    const client = createSocket();
    const guard = createGuard({
      verifyAsync: jest.fn(),
    });

    await expect(guard.canActivate(createWsContext(client))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects notification sockets when the token cannot be verified', async () => {
    const client = createSocket({
      handshake: {
        auth: { token: 'bad-token' },
        headers: {},
      } as any,
    });
    const guard = createGuard({
      verifyAsync: jest.fn().mockRejectedValue(new Error('jwt malformed')),
    });

    await expect(guard.canActivate(createWsContext(client))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('stores authenticated notification socket data from a valid token', async () => {
    const client = createSocket({
      handshake: {
        auth: { token: 'good-token' },
        headers: {},
      } as any,
    });
    const guard = createGuard(
      {
        verifyAsync: jest.fn().mockResolvedValue({
          sub: 'user-1',
          username: 'alice',
        }),
      },
      {
        findById: jest.fn().mockResolvedValue({
          id: 1,
          username: 'alice',
          role: 'user',
          is_active: true,
        }),
      },
    );

    await expect(guard.canActivate(createWsContext(client))).resolves.toBe(
      true,
    );

    expect(client.data).toEqual({
      userId: 'user-1',
      username: 'alice',
      wsAuthToken: 'good-token',
      user: {
        id: 1,
        username: 'alice',
        role: 'user',
        is_active: true,
      },
    });
  });

  it('rejects verified notification tokens without a subject claim', async () => {
    const client = createSocket({
      handshake: {
        auth: { token: 'missing-sub-token' },
        headers: {},
      } as any,
    });
    const guard = createGuard({
      verifyAsync: jest.fn().mockResolvedValue({ username: 'alice' }),
    });

    await expect(guard.canActivate(createWsContext(client))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(client.data).toEqual({});
  });

  it('keeps notification namespace CORS scoped to the configured frontend origin', () => {
    const { gateway } = createGateway();
    const server = {
      engine: { opts: {} },
    } as unknown as Server;
    (gateway as any).configService.get = jest.fn((key: string) =>
      key === 'FRONTEND_URL' ? 'https://app.xconfess.example' : undefined,
    );

    gateway.afterInit(server);

    expect(server.engine.opts.cors).toEqual({
      origin: 'https://app.xconfess.example',
      credentials: true,
    });
    expect(server.engine.opts.cors.origin).not.toBe(
      'https://evil.example',
    );
  });

  it('does not allow wrong origins in global websocket CORS options', () => {
    const options = buildWebSocketServerOptions('https://app.xconfess.example');

    expect(options.cors).toEqual({
      origin: 'https://app.xconfess.example',
      credentials: true,
      methods: ['GET', 'POST'],
    });
    expect((options.cors as any).origin).not.toBe('*');
    expect((options.cors as any).origin).not.toBe('https://evil.example');
  });

  it('joins only the authenticated user notification room on connection', () => {
    const { gateway, wsLogger } = createGateway();
    const client = createSocket({
      data: { userId: 'user-1' },
    });

    gateway.handleConnection(client);

    expect(client.join).toHaveBeenCalledWith('user:user-1');
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(wsLogger.logSubscriptionGranted).toHaveBeenCalledWith({
      socketId: 'socket-1',
      userId: 'user-1',
      channel: 'user:user-1',
    });
  });

  it('emits unread sync on connection for reconnect-safe notification loading', async () => {
    const { gateway } = createGateway();
    const client = createSocket({
      data: { userId: 'user-1' },
    });
    gateway.notificationService.getUserNotifications = jest.fn().mockResolvedValue({
      notifications: [{ id: 'missed-1' }],
      total: 1,
      unreadCount: 1,
    });

    gateway.handleConnection(client);
    await Promise.resolve();

    expect(gateway.notificationService.getUserNotifications).toHaveBeenCalledWith(
      'user-1',
      { page: 1, limit: 20, unreadOnly: true },
    );
    expect(client.emit).toHaveBeenCalledWith('notifications:sync', {
      notifications: [{ id: 'missed-1' }],
      unreadCount: 1,
      timestamp: expect.any(String),
    });
  });

  it('rejects private notification room subscriptions for another user', () => {
    const { gateway, wsLogger } = createGateway();
    const client = createSocket({
      data: { userId: 'user-1' },
    });

    gateway.handleSubscribeUserNotifications(client, { userId: 'user-2' });

    expect(client.join).not.toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith('subscription:rejected', {
      channel: 'user:user-2',
      reason: 'You can only subscribe to your own notification channel',
      timestamp: expect.any(String),
    });
    expect(wsLogger.logSubscriptionRejected).toHaveBeenCalledWith({
      socketId: 'socket-1',
      userId: 'user-1',
      channel: 'user:user-2',
      reason:
        "Ownership violation — authenticated as 'user-1', attempted to subscribe to 'user-2'",
    });
  });

  it('confirms private notification room subscriptions for the socket owner', () => {
    const { gateway, wsLogger } = createGateway();
    const client = createSocket({
      data: { userId: 'user-1' },
    });

    gateway.handleSubscribeUserNotifications(client, { userId: 'user-1' });

    expect(client.join).toHaveBeenCalledWith('user:user-1');
    expect(client.emit).toHaveBeenCalledWith('subscription:confirmed', {
      channel: 'user:user-1',
      timestamp: expect.any(String),
    });
    expect(wsLogger.logSubscriptionGranted).toHaveBeenCalledWith({
      socketId: 'socket-1',
      userId: 'user-1',
      channel: 'user:user-1',
    });
  });

  it('sends notification events only to the authenticated user room', async () => {
    const { gateway } = createGateway();
    const roomEmitter = { emit: jest.fn() };
    gateway.server = {
      to: jest.fn().mockReturnValue(roomEmitter),
    } as any;
    gateway.notificationService.getUserNotifications = jest
      .fn()
      .mockResolvedValue({ unreadCount: 3 });

    await gateway.sendNotificationToUser('user-1', { id: 'notif-1' });

    expect(gateway.server.to).toHaveBeenCalledWith('user:user-1');
    expect(roomEmitter.emit).toHaveBeenCalledWith('new-notification', { id: 'notif-1' });
    expect(roomEmitter.emit).toHaveBeenCalledWith('unread-count', { count: 3 });
  });

  // ─── Auth telemetry: correlation IDs and reason codes ──────────────

  it('rejects notification sockets with an expired token using EXPIRED_TOKEN reason code', async () => {
    const client = createSocket({
      handshake: {
        auth: { token: 'expired-token' },
        headers: {},
      } as any,
    });
    const guard = createGuard({
      verifyAsync: jest
        .fn()
        .mockRejectedValue(
          new TokenExpiredError('jwt expired', new Date('2024-01-01')),
        ),
    });

    let error: UnauthorizedException | undefined;
    try {
      await guard.canActivate(createWsContext(client));
    } catch (e) {
      error = e as UnauthorizedException;
    }

    expect(error).toBeDefined();
    expect(error!.getResponse()).toMatchObject({
      reasonCode: 'EXPIRED_TOKEN',
    });
  });

  it('includes a correlationId and reasonCode in auth failure responses', async () => {
    const client = createSocket();
    const guard = createGuard({
      verifyAsync: jest.fn(),
    });

    let error: UnauthorizedException | undefined;
    try {
      await guard.canActivate(createWsContext(client));
    } catch (e) {
      error = e as UnauthorizedException;
    }

    expect(error).toBeDefined();
    const response = error!.getResponse() as Record<string, unknown>;
    expect(response).toMatchObject({
      reasonCode: 'NO_TOKEN_PROVIDED',
    });
    expect(response).toHaveProperty('correlationId');
    expect(typeof response.correlationId).toBe('string');
  });

  it('redacts sensitive handshake headers after token extraction', async () => {
    const client = createSocket({
      handshake: {
        auth: {},
        headers: {
          authorization: 'Bearer super-secret-jwt',
          cookie: 'token=super-secret-cookie; foo=bar',
        },
      } as any,
    });

    // Token should be extracted from Authorization header
    const guard = createGuard({
      verifyAsync: jest.fn().mockRejectedValue(new Error('jwt malformed')),
    });

    await expect(guard.canActivate(createWsContext(client))).rejects.toThrow(
      UnauthorizedException,
    );

    // After extraction, the raw values should be scrubbed
    const headers = client.handshake?.headers as Record<string, string>;
    expect(headers['authorization']).not.toContain('super-secret-jwt');
    expect(headers['cookie']).not.toContain('super-secret-cookie');
  });

  it('rejects anonymous and expired connections in handshake middleware', async () => {
    const { gateway, jwtService, userRepository } = createGateway();
    let middleware:
      | ((socket: Socket, next: (error?: Error) => void) => void)
      | undefined;
    gateway.afterInit({
      engine: { opts: {} },
      use: jest.fn((handler) => {
        middleware = handler;
      }),
    } as any);
    expect(middleware).toBeDefined();

    const anonymous = createSocket();
    const anonymousError = await new Promise<Error | undefined>((resolve) =>
      middleware!(anonymous, resolve),
    );
    expect(anonymousError).toBeInstanceOf(Error);

    const authenticated = createSocket({
      handshake: { auth: { token: 'active-token' }, headers: {} } as any,
    });
    jwtService.verifyAsync.mockResolvedValue({ sub: '1', username: 'alice' });
    const authenticatedError = await new Promise<Error | undefined>((resolve) =>
      middleware!(authenticated, resolve),
    );
    expect(authenticatedError).toBeUndefined();
    expect(authenticated.data.userId).toBe('1');
    expect(userRepository.findOne).toHaveBeenCalledWith({
      where: { id: 1 },
      select: { id: true, is_active: true },
    });

    const inactive = createSocket({
      handshake: { auth: { token: 'inactive-token' }, headers: {} } as any,
    });
    jwtService.verifyAsync.mockResolvedValue({ sub: '2' });
    userRepository.findOne.mockResolvedValueOnce({ is_active: false });
    const inactiveError = await new Promise<Error | undefined>((resolve) =>
      middleware!(inactive, resolve),
    );
    expect(inactiveError).toBeInstanceOf(Error);
    expect(inactive.data.userId).toBeUndefined();

    const malformedSubject = createSocket({
      handshake: { auth: { token: 'malformed-subject-token' }, headers: {} } as any,
    });
    jwtService.verifyAsync.mockResolvedValue({ sub: '2admin' });
    const malformedError = await new Promise<Error | undefined>((resolve) =>
      middleware!(malformedSubject, resolve),
    );
    expect(malformedError).toBeInstanceOf(Error);
    expect(userRepository.findOne).toHaveBeenCalledTimes(2);

    const expired = createSocket({
      handshake: {
        auth: { token: 'expired-token' },
        headers: {},
      } as any,
    });
    jwtService.verifyAsync.mockRejectedValue(
      new TokenExpiredError('jwt expired', new Date()),
    );
    const expiredError = await new Promise<Error | undefined>((resolve) =>
      middleware!(expired, resolve),
    );
    expect(expiredError).toBeInstanceOf(Error);
    expect(expired.data.userId).toBeUndefined();
  });

  it('keeps auth refresh callable after the handshake token expires', () => {
    expect(
      Reflect.getMetadata(
        GUARDS_METADATA,
        NotificationGateway.prototype.handleAuthRefresh,
      ),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(
        GUARDS_METADATA,
        NotificationGateway.prototype.handleMarkRead,
      ),
    ).toContain(WsJwtGuard);
  });

  it('uses the rotated token for subsequent guarded notification events', async () => {
    const client = createSocket({
      handshake: {
        auth: { token: 'expired-handshake-token' },
        headers: {},
      } as any,
      data: { wsAuthToken: 'refreshed-token' },
    });
    const jwtService = { verifyAsync: jest.fn().mockResolvedValue({ sub: '1' }) };
    const guard = createGuard(jwtService);

    await expect(guard.canActivate(createWsContext(client))).resolves.toBe(true);

    expect(jwtService.verifyAsync).toHaveBeenCalledWith('refreshed-token');
    expect(client.data.wsAuthToken).toBe('refreshed-token');
  });

  it('moves a notification socket to the new account on successful refresh', async () => {
    const { gateway, jwtService } = createGateway();
    const client = createSocket({ data: { userId: '1' } });
    gateway.handleConnection(client);
    jwtService.verifyAsync.mockResolvedValue({
      sub: '2',
      username: 'second-user',
    });

    await gateway.handleAuthRefresh(client, { token: 'new-account-token' });

    expect(client.leave).toHaveBeenCalledWith('user:1');
    expect(client.join).toHaveBeenCalledWith('user:2');
    expect(client.data).toMatchObject({
      userId: '2',
      username: 'second-user',
      wsAuthToken: 'new-account-token',
    });
    expect((gateway as any).userSockets.has('1')).toBe(false);
    expect((gateway as any).userSockets.get('2')).toEqual(
      new Set([client.id]),
    );
    expect(client.emit).toHaveBeenCalledWith(
      'auth:refreshed',
      expect.objectContaining({ success: true, userId: '2' }),
    );
  });

  it('revokes an expired refreshed session and disconnects the socket', async () => {
    const { gateway, jwtService } = createGateway();
    const client = createSocket({ data: { userId: 'user-1' } });
    gateway.handleConnection(client);
    jwtService.verifyAsync.mockRejectedValue(
      new TokenExpiredError('jwt expired', new Date()),
    );

    await gateway.handleAuthRefresh(client, { token: 'expired-token' });

    expect(client.emit).toHaveBeenCalledWith(
      'auth:revoked',
      expect.objectContaining({ reason: 'SESSION_REVOKED_OR_EXPIRED' }),
    );
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('disconnects and clears tracking when refreshed account is inactive', async () => {
    const { gateway, jwtService, userRepository } = createGateway();
    const client = createSocket({ data: { userId: '1' } });
    gateway.handleConnection(client);
    jwtService.verifyAsync.mockResolvedValue({ sub: '2' });
    userRepository.findOne.mockResolvedValueOnce({ is_active: false });

    await gateway.handleAuthRefresh(client, { token: 'inactive-account-token' });

    expect(client.emit).toHaveBeenCalledWith(
      'auth:revoked',
      expect.objectContaining({ reason: 'SESSION_REVOKED_OR_EXPIRED' }),
    );
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect((gateway as any).userSockets.has('1')).toBe(false);
  });

  it('notifies and disconnects every tracked socket when a user is revoked', async () => {
    const { gateway } = createGateway();
    const client = createSocket({ data: { userId: 'user-1' } });
    gateway.server = {
      sockets: { sockets: new Map([[client.id, client]]) },
    } as any;
    gateway.handleConnection(client);

    await expect(gateway.revokeUserSessions('user-1')).resolves.toBe(1);

    expect(client.emit).toHaveBeenCalledWith(
      'auth:revoked',
      expect.objectContaining({ reason: 'SESSION_REVOKED' }),
    );
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect((gateway as any).userSockets.has('user-1')).toBe(false);
  });
});
