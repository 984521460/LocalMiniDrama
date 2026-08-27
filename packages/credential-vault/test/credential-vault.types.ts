import type {
  CredentialDescriptor,
  CredentialRef,
  CredentialVault,
} from '../src/index.js'

declare const vault: CredentialVault
declare const ref: CredentialRef

vault.store({
  kind: 'provider_token',
  secret: 'synthetic-value',
}).then((descriptor: CredentialDescriptor) => descriptor.configured)
vault.read(ref).then((resolved: string) => resolved.length)
vault.inspect(ref).then((configured: CredentialDescriptor) => configured.kind)
vault.remove(ref).then((removed: boolean) => removed)

// @ts-expect-error public descriptors never expose secret material
vault.inspect(ref).then((descriptor) => descriptor.secret)
// @ts-expect-error unsupported credential kinds fail at compile time
vault.store({ kind: 'password', secret: 'synthetic-value' })
