import { z } from 'zod';

export const ingestRequestSchema = z.object({
  request_id: z.string().optional(),
  readings: z.array(z.object({
    sensor_id: z.string().min(1),
    timestamp: z.string().datetime(),
    voltage: z.number(),
    current: z.number(),
    temperature: z.number(),
    status_code: z.string().min(1),
  })).min(1).max(1000),
});

export type IngestRequest = z.infer<typeof ingestRequestSchema>;
