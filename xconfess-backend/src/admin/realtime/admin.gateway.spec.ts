jest.mock('../../user/user.service', () => ({
  UserService: class UserService {},
}));

import { AdminGateway } from './admin.gateway';
import { UserRole } from '../../user/entities/user.entity';

const mockWsLogger = () => ({
  logSubscriptionRejected: jest.fn(),
  logSubscriptionGranted: jest.fn(),
  logEvent: jest.fn(),
});

const createGateway = (
  jwt: any,
  userService: any,
  wsLogger: any = mockWsLogger(),
) =>
  new AdminGateway(jwt, userService, wsLogger, {
    get: jest.fn(),
  } as any);

describe('AdminGateway', () => {
  it('emitNewReport broadcasts to admin:events room only', () => {
    const gateway = createGateway({}, {});
    const mockTo = jest.fn().mockReturnValue({ emit: jest.fn() });
    (gateway as any).server = { to: mockTo, emit: jest.fn() };

    gateway.emitNewReport({ x: 1 });
    expect(mockTo).toHaveBeenCalledWith('admin:events');
  });

  it('keeps every moderation report event scoped to the admin room', () => {
    const gateway = createGateway({}, {});
    const emitted: Array<[string, unknown]> = [];
    const mockTo = jest.fn().mockReturnValue({
      emit: (event: string, payload: unknown) => emitted.push([event, payload]),
    });
    (gateway as any).server = { to: mockTo, emit: jest.fn() };
    const report = { reportId: 'report-1' };
    const bulk = { reportIds: ['report-1', 'report-2'] };

    gateway.emitNewReport(report);
    gateway.emitReportUpdated(report);
    gateway.emitReportsBulkUpdated(bulk);

    expect(mockTo).toHaveBeenCalledTimes(3);
    expect(mockTo).toHaveBeenCalledWith('admin:events');
    expect(emitted).toEqual([
      ['new-report', report],
      ['report-updated', report],
      ['reports-bulk-updated', bulk],
    ]);
  });

  it('disconnects if no token provided', async () => {
    const jwt: any = { verify: jest.fn() };
    const userService: any = { findById: jest.fn() };
    const gateway = createGateway(jwt, userService);
    const client: any = {
      id: 's1',
      handshake: { auth: {}, headers: {} },
      data: {},
      disconnect: jest.fn(),
      join: jest.fn(),
    };
    await gateway.handleConnection(client);
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('accepts admin token and sets client data', async () => {
    const jwt: any = { verify: jest.fn().mockReturnValue({ sub: '1' }) };
    const userService: any = {
      findById: jest.fn().mockResolvedValue({
        role: UserRole.ADMIN,
        is_active: true,
      }),
    };
    const gateway = createGateway(jwt, userService);
    const client: any = {
      id: 's2',
      handshake: { auth: { token: 't' }, headers: {} },
      data: {},
      disconnect: jest.fn(),
      join: jest.fn(),
    };
    await gateway.handleConnection(client);
    expect(client.data.userId).toBe(1);
    expect(client.data.user).toEqual({ id: 1, role: UserRole.ADMIN });
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(client.join).toHaveBeenCalledWith('admin:events');
  });

  it('disconnects when token is expired during connection auth', async () => {
    const jwt: any = {
      verify: jest.fn(() => {
        throw new Error('jwt expired');
      }),
    };
    const userService: any = { findById: jest.fn() };
    const gateway = createGateway(jwt, userService);
    const client: any = {
      id: 's-expired',
      handshake: { auth: { token: 'expired-token' }, headers: {} },
      data: {},
      disconnect: jest.fn(),
      join: jest.fn(),
    };

    await gateway.handleConnection(client);

    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(userService.findById).not.toHaveBeenCalled();
  });

  it('rejects malformed subject IDs before looking up an account', async () => {
    const jwt: any = { verify: jest.fn().mockReturnValue({ sub: '1admin' }) };
    const userService: any = { findById: jest.fn() };
    const gateway = createGateway(jwt, userService);
    const client: any = {
      id: 's-invalid-subject',
      handshake: { auth: { token: 'invalid-subject-token' }, headers: {} },
      data: {},
      disconnect: jest.fn(),
      join: jest.fn(),
    };

    await gateway.handleConnection(client);

    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.join).not.toHaveBeenCalled();
    expect(userService.findById).not.toHaveBeenCalled();
  });

  it('supports reconnect after transient disconnect', async () => {
    const jwt: any = { verify: jest.fn().mockReturnValue({ sub: '42' }) };
    const userService: any = {
      findById: jest.fn().mockResolvedValue({
        role: UserRole.ADMIN,
        is_active: true,
      }),
    };
    const gateway = createGateway(jwt, userService);

    const firstClient: any = {
      id: 'socket-a',
      handshake: { auth: { token: 't' }, headers: {} },
      data: {},
      disconnect: jest.fn(),
      join: jest.fn(),
    };
    const secondClient: any = {
      id: 'socket-b',
      handshake: { auth: { token: 't' }, headers: {} },
      data: {},
      disconnect: jest.fn(),
      join: jest.fn(),
    };

    await gateway.handleConnection(firstClient);
    gateway.handleDisconnect(firstClient);
    await gateway.handleConnection(secondClient);

    expect(firstClient.data.userId).toBe(42);
    expect(secondClient.data.userId).toBe(42);
    expect(secondClient.disconnect).not.toHaveBeenCalled();
    expect(jwt.verify).toHaveBeenCalledTimes(2);
    expect(userService.findById).toHaveBeenCalledTimes(2);
  });

  it('logs rejected subscription when non-admin user connects', async () => {
    const jwt: any = { verify: jest.fn().mockReturnValue({ sub: '99' }) };
    const userService: any = {
      findById: jest.fn().mockResolvedValue({
        role: UserRole.USER,
        is_active: true,
      }),
    };
    const wsLogger = mockWsLogger();
    const gateway = createGateway(jwt, userService, wsLogger);
    const client: any = {
      id: 's-user',
      handshake: { auth: { token: 't' }, headers: {} },
      data: {},
      disconnect: jest.fn(),
      join: jest.fn(),
    };

    await gateway.handleConnection(client);

    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(wsLogger.logSubscriptionRejected).toHaveBeenCalledWith(
      expect.objectContaining({
        socketId: 's-user',
        userId: 99,
        channel: 'admin:events',
      }),
    );
  });

  it('rejects inactive admins before joining moderation event rooms', async () => {
    const jwt: any = { verify: jest.fn().mockReturnValue({ sub: '17' }) };
    const userService: any = {
      findById: jest.fn().mockResolvedValue({
        role: UserRole.ADMIN,
        is_active: false,
      }),
    };
    const gateway = createGateway(jwt, userService);
    const client: any = {
      id: 's-inactive',
      handshake: { auth: { token: 't' }, headers: {} },
      data: {},
      disconnect: jest.fn(),
      join: jest.fn(),
    };

    await gateway.handleConnection(client);

    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.join).not.toHaveBeenCalled();
  });

  it('moves a moderation socket to another active admin identity on refresh', async () => {
    const jwt: any = {
      verify: jest.fn().mockReturnValue({ sub: '2' }),
    };
    const userService: any = {
      findById: jest
        .fn()
        .mockResolvedValueOnce({ role: UserRole.ADMIN, is_active: true })
        .mockResolvedValueOnce({ role: UserRole.ADMIN, is_active: true }),
    };
    const gateway = createGateway(jwt, userService);
    const client: any = {
      id: 's-refresh',
      handshake: { auth: { token: 'first-token' }, headers: {} },
      data: {},
      disconnect: jest.fn(),
      join: jest.fn(),
      emit: jest.fn(),
    };
    await gateway.handleConnection(client);

    await gateway.handleAuthRefresh(client, { token: 'second-account-token' });

    expect(client.data.userId).toBe(2);
    expect(client.data.wsAuthToken).toBe('second-account-token');
    expect((gateway as any).userSockets.has(1)).toBe(false);
    expect((gateway as any).userSockets.get(2)).toEqual(new Set([client.id]));
    expect(client.emit).toHaveBeenCalledWith(
      'auth:refreshed',
      expect.objectContaining({ success: true, userId: '2' }),
    );
  });

  it('rejects a refresh without a token but keeps the current session open', async () => {
    const gateway = createGateway({}, {});
    const client: any = {
      id: 's-missing-refresh',
      data: { userId: 1 },
      disconnect: jest.fn(),
      emit: jest.fn(),
    };

    await gateway.handleAuthRefresh(client, {});

    expect(client.emit).toHaveBeenCalledWith(
      'auth:rejected',
      expect.objectContaining({ reason: 'NO_TOKEN_PROVIDED' }),
    );
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('disconnects when refresh changes an admin socket to a non-admin account', async () => {
    const jwt: any = { verify: jest.fn().mockReturnValue({ sub: '2' }) };
    const userService: any = {
      findById: jest
        .fn()
        .mockResolvedValueOnce({ role: UserRole.ADMIN, is_active: true })
        .mockResolvedValueOnce({ role: UserRole.USER, is_active: true }),
    };
    const gateway = createGateway(jwt, userService);
    const client: any = {
      id: 's-demoted',
      handshake: { auth: { token: 'admin-token' }, headers: {} },
      data: {},
      disconnect: jest.fn(),
      join: jest.fn(),
      emit: jest.fn(),
    };
    await gateway.handleConnection(client);

    await gateway.handleAuthRefresh(client, { token: 'user-token' });

    expect(client.emit).toHaveBeenCalledWith(
      'auth:revoked',
      expect.objectContaining({ reason: 'SESSION_REVOKED_OR_EXPIRED' }),
    );
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect((gateway as any).userSockets.has(1)).toBe(false);
  });

  it('disconnects an admin socket when its refreshed session is expired', async () => {
    const jwt: any = {
      verify: jest
        .fn()
        .mockReturnValueOnce({ sub: '1' })
        .mockImplementationOnce(() => {
          throw new Error('jwt expired');
        }),
    };
    const userService: any = {
      findById: jest
        .fn()
        .mockResolvedValue({ role: UserRole.ADMIN, is_active: true }),
    };
    const gateway = createGateway(jwt, userService);
    const client: any = {
      id: 's-expired-refresh',
      handshake: { auth: { token: 'first-token' }, headers: {} },
      data: {},
      disconnect: jest.fn(),
      join: jest.fn(),
      emit: jest.fn(),
    };
    await gateway.handleConnection(client);

    await gateway.handleAuthRefresh(client, { token: 'expired-token' });

    expect(client.emit).toHaveBeenCalledWith(
      'auth:revoked',
      expect.objectContaining({ reason: 'SESSION_REVOKED_OR_EXPIRED' }),
    );
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect((gateway as any).userSockets.has(1)).toBe(false);
  });

  it('disconnects all moderation sockets when an admin session is revoked', async () => {
    const jwt: any = { verify: jest.fn().mockReturnValue({ sub: '1' }) };
    const userService: any = {
      findById: jest
        .fn()
        .mockResolvedValue({ role: UserRole.ADMIN, is_active: true }),
    };
    const gateway = createGateway(jwt, userService);
    const client: any = {
      id: 's-revoked',
      handshake: { auth: { token: 'token' }, headers: {} },
      data: {},
      disconnect: jest.fn(),
      join: jest.fn(),
      emit: jest.fn(),
    };
    await gateway.handleConnection(client);
    (gateway as any).server = {
      sockets: { sockets: new Map([[client.id, client]]) },
    };

    expect(gateway.revokeUserSessions(1)).toBe(1);

    expect(client.emit).toHaveBeenCalledWith(
      'auth:revoked',
      expect.objectContaining({ reason: 'SESSION_REVOKED' }),
    );
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect((gateway as any).userSockets.has(1)).toBe(false);
  });
});
