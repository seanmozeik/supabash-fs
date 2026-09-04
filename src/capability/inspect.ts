import type { PostgresDelegatedCapabilityClaims } from '../api/capability.js';
import { SupabashError } from '../api/errors.js';
import { assertClaimSchema, parseClaims } from './claims.js';
import { peekCompactJwsPayload } from './jws.js';

/**
 * Reads the claims of a Postgres capability without checking its signature.
 * A delegate holds no verification secret, so these claims carry no authority.
 * They only bound the request the delegate is about to make and are checked
 * against the grant that the database returns.
 */
export const inspectPostgresCapability = (
  capability: string,
): PostgresDelegatedCapabilityClaims => {
  let claims;
  try {
    claims = parseClaims(peekCompactJwsPayload(capability));
    assertClaimSchema(claims);
  } catch (error) {
    if (error instanceof SupabashError) {
      throw error;
    }
    throw new SupabashError('INVALID_CAPABILITY', 'Capability is not a readable compact JWS.', {
      cause: error,
    });
  }
  if (!('backend' in claims)) {
    throw new SupabashError('INVALID_CAPABILITY', 'Capability backend is not Postgres.');
  }
  return claims;
};
