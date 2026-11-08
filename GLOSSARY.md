# DiscourseConnect Authentication

Shared language for signing into an application using a Discourse identity.

## Language

**Identity provider**:
The Discourse site that authenticates a person and supplies their identity to the consuming application.
_Avoid_: SSO backend

**DiscourseConnect consumer**:
The application that relies on a Discourse identity provider to authenticate its users.

**DiscourseConnect**:
Discourse's signed-payload single sign-on protocol between an identity provider and a consumer.
_Avoid_: OAuth, OpenID Connect

**Local user**:
The consuming application's representation of a person, which can have multiple authentication methods linked to it.

**Discourse identity**:
The identity assigned to a person by the configured Discourse site, identified by its stable external identifier rather than an email address or username.

**Linked account**:
The association between a local user and an identity from an authentication provider.
_Avoid_: User

**Local session**:
An authenticated session in the consuming application, independent of the person's session on Discourse.

**DiscourseConnect transaction**:
A single browser-bound attempt to sign in or explicitly link a Discourse identity, connecting an authorization request to its corresponding callback.
