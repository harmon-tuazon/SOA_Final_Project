// Express middleware verifying the Cognito ID token on every protected
// route (PRD §3.4). Verification is a signature check against the pool's
// public JWKS — the service holds no Cognito credential and makes no
// outbound Cognito API call.

const { CognitoJwtVerifier } = require('aws-jwt-verify');

// Built lazily on first use (not at module load) so that requiring this
// module — e.g. from /health, or from tests that never hit a protected
// route — never throws just because COGNITO_USER_POOL_ID/CLIENT_ID aren't
// set in the environment yet.
let verifier;
let verifierAttempted = false;

function getVerifier() {
  if (!verifierAttempted) {
    verifierAttempted = true;
    const userPoolId = process.env.COGNITO_USER_POOL_ID;
    const clientId = process.env.COGNITO_CLIENT_ID;
    if (userPoolId && clientId) {
      verifier = CognitoJwtVerifier.create({
        userPoolId,
        tokenUse: 'id',
        clientId,
      });
    }
  }
  return verifier;
}

/**
 * Requires a valid Bearer ID token. On success, attaches
 * req.user = { sub, email } from the verified token's claims and calls
 * next(). On any failure — missing header, invalid/expired token, wrong
 * audience, or auth not configured — responds 401 with { error }.
 */
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);

  if (!match) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const activeVerifier = getVerifier();
  if (!activeVerifier) {
    return res.status(401).json({ error: 'Auth not configured' });
  }

  try {
    const payload = await activeVerifier.verify(match[1]);
    req.user = { sub: payload.sub, email: payload.email };
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { requireAuth };
