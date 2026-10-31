/**
 * Auth0 Post-Login Action: "SAAS_RSA claims"
 *
 * Paste into Auth0 Dashboard -> Actions -> Library -> Create Action
 * (trigger: Login / Post Login), add the secrets below, deploy it, then drag it
 * into Actions -> Triggers -> post-login.
 *
 * Secrets (Action settings -> Secrets):
 *   API_BASE_URL        e.g. https://saasrsa-api.<env>.southafricanorth.azurecontainerapps.io
 *   AUTH_ACTION_SECRET  same value as the API's AUTH_ACTION_SECRET (32+ characters)
 *   CLAIM_NAMESPACE     optional, defaults to https://saas-rsa.app/
 *
 * Staff sign in with SMS passwordless (their phone number). Their first login links
 * to the employee record a manager created with that number; later logins use the
 * linked Auth0 subject. People who belong to several organisations pick one with
 * the `org` authorization parameter (e.g. loginWithRedirect({ authorizationParams: { org } })).
 */
exports.onExecutePostLogin = async (event, api) => {
  const ns = event.secrets.CLAIM_NAMESPACE || 'https://saas-rsa.app/';
  const requestedOrg = event.request.query && event.request.query.org;

  let response;
  try {
    response = await fetch(`${event.secrets.API_BASE_URL}/internal/auth/claims`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-secret': event.secrets.AUTH_ACTION_SECRET,
      },
      body: JSON.stringify({
        sub: event.user.user_id,
        phone: event.user.phone_number || null,
        phoneVerified: Boolean(event.user.phone_verified),
        email: event.user.email || null,
        emailVerified: Boolean(event.user.email_verified),
        orgId: requestedOrg || null,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    return api.access.deny('Sign-in is temporarily unavailable. Please try again.');
  }

  if (response.status === 403) {
    return api.access.deny('Your account is not linked to a workplace yet. Ask your manager to add you.');
  }
  if (!response.ok) {
    return api.access.deny('Sign-in is temporarily unavailable. Please try again.');
  }

  const claims = await response.json();
  api.accessToken.setCustomClaim(`${ns}user_id`, claims.userId);
  api.accessToken.setCustomClaim(`${ns}org_id`, claims.orgId);
  api.accessToken.setCustomClaim(`${ns}role`, claims.role);
  api.accessToken.setCustomClaim(`${ns}location_ids`, claims.locationIds);
  // ID token gets display hints only (the app's organisation switcher); never used for access.
  api.idToken.setCustomClaim(`${ns}organisations`, claims.organisations);
};
