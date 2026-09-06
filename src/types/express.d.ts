// Augments Express's Request type so `req.userId` is recognized everywhere
// after the `requireAuth` middleware runs, without resorting to `any`.
declare namespace Express {
  export interface Request {
    userId?: string;
  }
}
