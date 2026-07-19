use anyhow::{Context, Result, bail};
use base64ct::{Base64UrlUnpadded, Encoding};
use ciborium::value::{Integer, Value as CborValue};
use coset::{CborSerializable, CoseSign1Builder, HeaderBuilder, iana};
use p256::{
    ecdsa::{Signature, SigningKey, signature::Signer},
    elliptic_curve::rand_core::{OsRng, RngCore},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExecutionJwk {
    pub kty: String,
    pub crv: String,
    pub alg: String,
    #[serde(rename = "use")]
    pub key_use: String,
    pub kid: String,
    pub x: String,
    pub y: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub d: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionIdentity {
    pub key_id: String,
    pub public_key: ExecutionJwk,
    pub private_key: ExecutionJwk,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignExecutionInput {
    pub request: Value,
    pub gateway_id: String,
    pub issuer: String,
    pub subject: String,
    pub operation: String,
    pub ttl_seconds: Option<u64>,
}

pub fn generate_execution_identity() -> ExecutionIdentity {
    let signing = SigningKey::random(&mut OsRng);
    let point = signing.verifying_key().to_encoded_point(false);
    let x = Base64UrlUnpadded::encode_string(point.x().expect("P-256 x coordinate"));
    let y = Base64UrlUnpadded::encode_string(point.y().expect("P-256 y coordinate"));
    let key_id = jwk_thumbprint(&x, &y);
    let public_key = ExecutionJwk {
        kty: "EC".into(),
        crv: "P-256".into(),
        alg: "ES256".into(),
        key_use: "sig".into(),
        kid: key_id.clone(),
        x: x.clone(),
        y: y.clone(),
        d: None,
    };
    let private_key = ExecutionJwk {
        d: Some(Base64UrlUnpadded::encode_string(&signing.to_bytes())),
        ..public_key.clone()
    };
    ExecutionIdentity {
        key_id,
        public_key,
        private_key,
    }
}

pub fn sign_execution_token(key: &ExecutionJwk, input: SignExecutionInput) -> Result<String> {
    validate_key(key, true)?;
    for (name, value) in [
        ("gatewayId", &input.gateway_id),
        ("issuer", &input.issuer),
        ("subject", &input.subject),
        ("operation", &input.operation),
    ] {
        if value.trim().is_empty() {
            bail!("{name} is required");
        }
    }
    let ttl = input.ttl_seconds.unwrap_or(90);
    if !(1..=300).contains(&ttl) {
        bail!("execution token TTL must be between 1 and 300 seconds");
    }
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let request_bytes =
        serde_json::to_vec(&input.request).context("request is not JSON serializable")?;
    let request_hash = Sha256::digest(request_bytes).to_vec();
    let mut token_id = [0u8; 16];
    OsRng.fill_bytes(&mut token_id);
    let claims = CborValue::Map(vec![
        (int(1), CborValue::Text(input.issuer)),
        (int(2), CborValue::Text(input.subject)),
        (int(3), CborValue::Text(input.gateway_id)),
        (int(4), int(now + ttl)),
        (int(5), int(now.saturating_sub(15))),
        (int(6), int(now)),
        (int(7), CborValue::Bytes(token_id.to_vec())),
        (
            CborValue::Text("codever.operations".into()),
            CborValue::Array(vec![CborValue::Text(input.operation)]),
        ),
        (
            CborValue::Text("codever.request_hash".into()),
            CborValue::Bytes(request_hash),
        ),
    ]);
    let mut payload = Vec::new();
    ciborium::ser::into_writer(&claims, &mut payload).context("failed to encode CWT claims")?;
    let signing = signing_key(key)?;
    let protected = HeaderBuilder::new()
        .algorithm(iana::Algorithm::ES256)
        .key_id(key.kid.as_bytes().to_vec())
        .build();
    let sign1 = CoseSign1Builder::new()
        .protected(protected)
        .payload(payload)
        .create_signature(&[], |data| {
            let signature: Signature = signing.sign(data);
            signature.to_bytes().to_vec()
        })
        .build();
    Ok(Base64UrlUnpadded::encode_string(&sign1.to_vec()?))
}

fn signing_key(key: &ExecutionJwk) -> Result<SigningKey> {
    let encoded = key
        .d
        .as_ref()
        .context("execution signing key has no private material")?;
    let bytes =
        Base64UrlUnpadded::decode_vec(encoded).context("execution private key is invalid")?;
    SigningKey::from_slice(&bytes).context("execution private key is invalid")
}

fn validate_key(key: &ExecutionJwk, private: bool) -> Result<()> {
    if key.kty != "EC" || key.crv != "P-256" || key.alg != "ES256" || key.key_use != "sig" {
        bail!("execution key must be an ES256 P-256 signing key");
    }
    if private && key.d.is_none() {
        bail!("execution private key is required");
    }
    if jwk_thumbprint(&key.x, &key.y) != key.kid {
        bail!("execution key ID does not match its public key");
    }
    Ok(())
}

fn jwk_thumbprint(x: &str, y: &str) -> String {
    let canonical = format!(r#"{{"crv":"P-256","kty":"EC","x":"{x}","y":"{y}"}}"#);
    Base64UrlUnpadded::encode_string(&Sha256::digest(canonical.as_bytes()))
}

fn int<T: Into<Integer>>(value: T) -> CborValue {
    CborValue::Integer(value.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use coset::CoseSign1;
    use p256::{
        EncodedPoint,
        ecdsa::{VerifyingKey, signature::Verifier},
    };

    #[test]
    fn generated_identity_signs_a_standard_cose_sign1() {
        let identity = generate_execution_identity();
        let token = sign_execution_token(
            &identity.private_key,
            SignExecutionInput {
                request: serde_json::json!({"payload":{"kind":"session.cancel"},"version":1}),
                gateway_id: "gateway-1".into(),
                issuer: "codever-control:owner".into(),
                subject: "phone".into(),
                operation: "session.cancel".into(),
                ttl_seconds: Some(90),
            },
        )
        .unwrap();
        let sign1 = CoseSign1::from_slice(&Base64UrlUnpadded::decode_vec(&token).unwrap()).unwrap();
        let x = Base64UrlUnpadded::decode_vec(&identity.public_key.x).unwrap();
        let y = Base64UrlUnpadded::decode_vec(&identity.public_key.y).unwrap();
        let point =
            EncodedPoint::from_affine_coordinates(x.as_slice().into(), y.as_slice().into(), false);
        let verifying = VerifyingKey::from_encoded_point(&point).unwrap();
        sign1
            .verify_signature(&[], |signature, data| {
                verifying
                    .verify(data, &Signature::from_slice(signature).unwrap())
                    .map_err(|_| ())
            })
            .unwrap();
    }
}
