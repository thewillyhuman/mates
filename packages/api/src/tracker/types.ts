import { z } from 'zod';

/** Ticket content as fetched from the tracker (§8 `getTicket`), stored in `tickets.details`. */
export const ticketDetailsSchema = z.object({
  description: z.string().default(''),
  acceptance_criteria: z.string().default(''),
  comments: z
    .array(
      z.object({
        id: z.string().default(''),
        author: z.string(),
        body: z.string(),
        created_at: z.string().default(''),
      }),
    )
    .default([]),
  links: z.array(z.string()).default([]),
  labels: z.array(z.string()).default([]),
  reporter: z.string().default(''),
  assignee: z.string().default(''),
  status: z.string().default(''),
});
export type TicketDetails = z.infer<typeof ticketDetailsSchema>;

export const emptyTicketDetails = (): TicketDetails => ticketDetailsSchema.parse({});
