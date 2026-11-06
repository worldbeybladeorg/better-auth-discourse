import { APIError, createAuthEndpoint } from "better-auth/api";
import { z } from "zod";
import { createDiscourseConnectRequest } from "../protocol.js";
import { createTransactionState } from "../state.js";
import { createBetterAuthTransactionStateStorage } from "../storage/better-auth.js";
import {
  activeSession,
  callbackEndpointURL,
  destination,
  originPolicy,
  sessionToken,
  setBinding,
} from "./common.js";
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
        let session;
        try {
          session = await activeSession(ctx);
        } catch {
          session = null;
        }
        const token = sessionToken(ctx);
        if (!session?.user?.id || !session?.session?.id || !token)
          throw discourseAPIError("SESSION_REQUIRED");
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const successURL = destination(ctx, body.callbackURL, "/");
        const errorURL = destination(ctx, body.errorCallbackURL, successURL);
        const callbackURL = callbackEndpointURL(ctx);
        const state = await createTransactionState(
          createBetterAuthTransactionStateStorage(ctx.context.adapter),
          {
            operation: "link",
            successURL,
            errorURL,
            trustedOrigins: originPolicy(ctx),
            initiatingUserId: session.user.id,
            initiatingSessionId: session.session.id,
            initiatingSessionToken: token,
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
      } catch (error) {
        if (error instanceof APIError) throw error;
        throw discourseAPIError("INVALID_REQUEST");
      }
    },
  );
