import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '4000'),
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/gridwatch',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  jwtSecret: process.env.JWT_SECRET || 'gridwatch-dev-secret',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
};
