import { createAuthEndpoint } from "better-auth/api";
import { z } from "zod";
import { createDiscourseConnectRequest } from "../protocol.js";
import { createTransactionState } from "../state.js";
import { createBetterAuthTransactionStateStorage } from "../storage/better-auth.js";
import {
  callbackEndpointURL,
  destination,
  originPolicy,
  setBinding,
} from "./common.js";
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
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const successURL = destination(ctx, body.callbackURL, "/");
        const errorURL = destination(ctx, body.errorCallbackURL, successURL);
        const callbackURL = callbackEndpointURL(ctx);
        const state = await createTransactionState(
          createBetterAuthTransactionStateStorage(ctx.context.adapter),
          {
            operation: "sign-in",
            successURL,
            errorURL,
            trustedOrigins: originPolicy(ctx),
          },
          ctx.context.secret,
        );
        const request = await createDiscourseConnectRequest({
          discourseURL: options.discourseURL,
          returnSSOURL: callbackURL,
          nonce: state.nonce,
          secret: options.secret,
        });
        setBinding(ctx, state.nonce, state.browserSecret, state.expiresAt);
        return ctx.json({ url: request.authorizationURL, redirect: true });
      } catch {
        throw discourseAPIError("INVALID_REQUEST");
      }
    },
  );
