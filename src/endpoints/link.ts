import { APIError, createAuthEndpoint } from "better-auth/api";
import { z } from "zod";
import { beginDiscourseTransaction } from "./transaction.js";
import { discourseAPIError } from "../errors.js";

export const createLinkDiscourse = (options: {
  discourseURL: string;
  secret: string;
}) =>
  createAuthEndpoint(
    "/discourse/link",
    {
      method: "POST",
      body: z.object({
        callbackURL: z.string().optional(),
        errorCallbackURL: z.string().optional(),
      }),
    },
    async (ctx) => {
      try {
        return ctx.json(await beginDiscourseTransaction(ctx, options, "link"));
      } catch (error) {
        if (error instanceof APIError) throw error;
        throw discourseAPIError("INVALID_REQUEST");
      }
    },
  );
