// Error codes for client identification
export const ErrorCodes = {
  // Authentication (1xxx)
  UNAUTHORIZED: 'AUTH_001',
  INVALID_TOKEN: 'AUTH_002',
  TOKEN_EXPIRED: 'AUTH_003',
  INSUFFICIENT_PERMISSIONS: 'AUTH_004',
  DEVICE_REVOKED: 'AUTH_005',
  SESSION_INVALIDATED: 'AUTH_006',
  MOBILE_TOKEN_REQUIRED: 'AUTH_007',
  CLIENT_TOO_OLD: 'AUTH_008',

  // Validation (2xxx)
  VALIDATION_ERROR: 'VAL_001',
  INVALID_INPUT: 'VAL_002',
  MISSING_FIELD: 'VAL_003',

  // Resource (3xxx)
  NOT_FOUND: 'RES_001',
  ALREADY_EXISTS: 'RES_002',
  CONFLICT: 'RES_003',

  // Server (4xxx)
  INTERNAL_ERROR: 'SRV_001',
  SERVICE_UNAVAILABLE: 'SRV_002',
  DATABASE_ERROR: 'SRV_003',
  REDIS_ERROR: 'SRV_004',

  // Rate limiting (5xxx)
  RATE_LIMITED: 'RATE_001',

  // External services (6xxx)
  PLEX_ERROR: 'EXT_001',
  JELLYFIN_ERROR: 'EXT_002',
  GEOIP_ERROR: 'EXT_003',
  EMBY_ERROR: 'EXT_004',
  TOFA_ERROR: 'EXT_005',
  SILO_ERROR: 'EXT_006',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
