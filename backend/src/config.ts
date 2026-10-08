export interface Config {
  databaseUrl: string;
  secret: string;
  adminEmail: string;
  adminPassword: string;
  port: number;
}

export function loadConfig(env = process.env): Config {
  const databaseUrl = env.DATABASE_URL ?? '';
  const secret = env.APP_SECRET ?? '';
  const adminEmail = (env.APP_ADMIN_EMAIL ?? '').trim().toLowerCase();
  const adminPassword = env.APP_ADMIN_PASSWORD ?? '';
  const port = Number(env.APP_PORT ?? 8080);
  if (!databaseUrl.startsWith('postgresql://') && !databaseUrl.startsWith('postgres://')) throw new Error('DATABASE_URL must be a PostgreSQL URL');
  if (secret.length < 32) throw new Error('APP_SECRET must contain at least 32 characters');
  if (!adminEmail.includes('@')) throw new Error('APP_ADMIN_EMAIL must be a valid email');
  if (adminPassword.length < 12) throw new Error('APP_ADMIN_PASSWORD must contain at least 12 characters');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('APP_PORT is invalid');
  return { databaseUrl, secret, adminEmail, adminPassword, port };
}

