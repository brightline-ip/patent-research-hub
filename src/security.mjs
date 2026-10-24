const namedSecret = /((?:["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|cookie|set-cookie|private[_-]?key)(?:["']?)\s*[:=]\s*(?:["']?))([^"'\s,;}]{4,})/gi;
const signedParameter = /([?&](?:x-goog-(?:credential|signature)|x-amz-(?:credential|signature|security-token)|signature|token|key|credential)=)[^&#\s]*/gi;
const authorization = /\b(?:Bearer\s+[A-Za-z0-9._~+/=-]{20,}|Basic\s+[A-Za-z0-9+/=]{20,}|Token\s+[A-Za-z0-9._~+/=-]{20,})/gi;
const privateKey = /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi;
const vendorToken = /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g;

export function redactSensitiveText(value){
  return String(value??'')
    .replace(privateKey,'[REDACTED PRIVATE KEY]')
    .replace(authorization,match=>match.slice(0,match.indexOf(' '))+' [REDACTED]')
    .replace(namedSecret,'$1[REDACTED]')
    .replace(signedParameter,'$1[REDACTED]')
    .replace(vendorToken,'[REDACTED TOKEN]');
}

export function safeErrorMessage(value,fallback='Operation failed; sensitive details were suppressed'){
  const original=String(value??'').trim();
  if(!original)return fallback;
  const redacted=redactSensitiveText(original);
  if(redacted!==original)return fallback;
  return redacted.replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').slice(0,300)||fallback;
}

export function assertNoSensitiveText(value){
  const text=String(value??'');
  if(redactSensitiveText(text)!==text)throw new Error('Possible credential in public research content; remove secrets');
}
