import { createAuthEndpoint } from "better-auth/api";
import { z } from "zod";
import { beginDiscourseTransaction } from "./transaction.js";
import { discourseAPIError } from "../errors.js";

export const createSignInDiscourse = (options: {
  discourseURL: string;
  secret: string;
}) =>
  createAuthEndpoint(
    "/sign-in/discourse",
    {
      method: "POST",
      body: z.object({
        callbackURL: z.string().optional(),
        errorCallbackURL: z.string().optional(),
      }),
    },
    async (ctx) => {
      try {
        return ctx.json(
          await beginDiscourseTransaction(ctx, options, "sign-in"),
        );
      } catch {
        throw discourseAPIError("INVALID_REQUEST");
      }
    },
  );
