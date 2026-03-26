export interface JwtUserPayload {
  userId: string;
  role: 'operator' | 'supervisor';
  zoneIds: string[];
}

export interface ZoneAccessContext {
  userId: string;
  role: 'operator' | 'supervisor';
  zoneIds: string[];
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtUserPayload;
    }
  }
}
