// Shared "auth not configured" state for the auth screens (PRD user/0001
// §4.6): config.json ships empty cognitoUserPoolId/cognitoClientId until
// platform/0009's Cognito pool is deployed and wired in. The screens must
// degrade gracefully rather than render a form that can never succeed.
export function NotConfiguredNotice() {
  return (
    <p role="status">
      Authentication is not configured yet — sign-in and registration are unavailable until the
      Cognito user pool is deployed.
    </p>
  );
}
