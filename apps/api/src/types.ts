export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  CORS_ORIGIN?: string;
  JWT_SECRET?: string;
  ADMIN_USERNAME?: string;
  ADMIN_DEFAULT_PASSWORD?: string;
}

export interface JwtUserPayload {
  sub: string;
  username: string;
  role: 'admin';
  exp: number;
}
