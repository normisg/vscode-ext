#!/bin/sh
# Decode a JWT from stdin and verify it's signature with the JWT issuer public key
# Only RS256 keys are supported for signature check
#
# Put OAuth server public key in PEM format to /var/cache/oauth/$JWT_KID.key.pub.pem
# You must create the folder first
# $ sudo mkdir -p /var/cache/oauth/
# To converted key from JWK to PEM use https://8gwifi.org/jwkconvertfunctions.jsp or https://keytool.online/
# NOTE: For Google you can get the keys in PEM format via https://www.googleapis.com/oauth2/v1/certs
#  Decode the keys with decodeURIComponent()
# TODO fetch public key automatically in https://jwt.io/ manner:
#  get "kid" field from JWT header
#  get "iss" field from JWT header which is the token issuer url e.g. https://accounts.google.com
#  add /.well-known/openid-configuration and fetch OIDC discovery e.g. wget https://accounts.google.com/.well-known/openid-configuration
#  from the OIDC discovery JSON take jwks_uri e.g. https://www.googleapis.com/oauth2/v3/certs
#  in the JWKS find the public key (JWK) which signed the JWT
#  convert the JWK to PEM format to make openssl happy
#  store the fetched pub key into /var/cache/ and next time check it there first to avoid calls to jwks_uri
# HOW TO USE:
# $ chmod +x jwt-decode.sh
# Parse file:
# $ cat id_token.txt | ./jwt-decode.sh
# if signature check failed then error code will be non-zero

if [ -z $(command -v jq) ]; then
    echo "This script will NOT work on your machine."
    echo "Please install jq first: https://stedolan.github.io/jq/download/"
    exit 1
fi

base64_padding()
{
  local len=$(( ${#1} % 4 ))
  local padded_b64=''
  if [ ${len} = 2 ]; then
    padded_b64="${1}=="
  elif [ ${len} = 3 ]; then
    padded_b64="${1}="
  else
    padded_b64="${1}"
  fi
  echo -n "$padded_b64"
}

base64url_to_b64()
{
  base64_padding "${1}" | tr -- '-_' '+/'
}

# read the JWT from stdin and split by comma into three variables
IFS='.' read -r JWT_HEADER_B64URL JWT_PAYLOAD_B64URL JWT_SIGNATURE_B64URL

JWT_HEADER_B64=$(base64url_to_b64 ${JWT_HEADER_B64URL})
JWT_PAYLOAD_B64=$(base64url_to_b64 ${JWT_PAYLOAD_B64URL})
JWT_SIGNATURE_B64=$(base64url_to_b64 ${JWT_SIGNATURE_B64URL})

JWT_HEADER=$(echo "${JWT_HEADER_B64}" | base64 -d)
JWT_PAYLOAD=$(echo "${JWT_PAYLOAD_B64}" | base64 -d)

echo "JWT Header:"
echo "${JWT_HEADER}" | jq
echo "JWT Payload:"
echo "${JWT_PAYLOAD}" | jq
echo "JWT Signature (Base 64 padded):"
echo "${JWT_SIGNATURE_B64}"

JWT_ALG=$(echo "$JWT_HEADER" | jq -r .alg)
JWT_KID=$(echo "$JWT_HEADER" | jq -r .kid)
JWT_TYP=$(echo "$JWT_HEADER" | jq -r .typ)
JWT_ISS=$(echo "$JWT_PAYLOAD" | jq -r .iss)
JWT_SUB=$(echo "$JWT_PAYLOAD" | jq -r .sub)
JWT_EMAIL=$(echo "$JWT_PAYLOAD" | jq -r .email)
JWT_IAT=$(echo "$JWT_PAYLOAD" | jq -r .iat)
echo "alg: $JWT_ALG kid: $JWT_KID"
echo "sub: $JWT_SUB email: $JWT_EMAIL iat: $JWT_IAT"

# verify signature
if [ ${JWT_ALG} = "RS256" ]; then
    PUB_KEY_FILE="/var/tmp/oauth/$JWT_KID.key.pub.pem"
    if [ ! -f $PUB_KEY_FILE ]; then
      >&2 echo "No pub key $JWT_KID"
      if [ $JWT_ISS = "https://accounts.google.com" ]; then
        mkdir -p /var/tmp/oauth/
        # use old jwks_url which return certs in PEM format
        OAUTH_CERTS_URL="https://www.googleapis.com/oauth2/v1/certs"
        echo "Fetch it from $OAUTH_CERTS_URL"
        wget $OAUTH_CERTS_URL -q -O /tmp/jwks.json
        CERT_FILE="/tmp/$JWT_KID.crt"
        jq -r ".$JWT_KID" /tmp/jwks.json > "$CERT_FILE"
        rm /tmp/jwks.json
        openssl x509 -pubkey -in "$CERT_FILE" -noout > "$PUB_KEY_FILE"
        rm "$CERT_FILE"
      else
         exit 1
      fi
    fi
    SIG_FILE="/tmp/$JWT_SUB-$JWT_IAT.sig.dat"
    echo -n "$JWT_SIGNATURE_B64" | base64 -d > ${SIG_FILE}
    JWT_BODY=$(echo -n "$JWT_HEADER_B64URL.$JWT_PAYLOAD_B64URL")
    echo -n "$JWT_BODY" | openssl dgst -sha256 -verify "${PUB_KEY_FILE}" -signature ${SIG_FILE}
    JWT_SIG_VERIFIED=$?
    rm ${SIG_FILE}
    if [ ${JWT_SIG_VERIFIED} -ne 0 ]; then
      >&2 echo "Bad Signature"
      exit ${JWT_SIG_VERIFIED}
      exit;
    fi
else
    >&2 echo "Error 3: Unsupported signature algorithm $JWT_ALG"
    exit 3
fi
