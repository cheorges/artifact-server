import type {
  ApplicationSession,
  InstallationMember,
  LoginAttempt,
  ManagedApiKey,
  StoredManagedApiKey,
} from "./installation-identity.js";

/** Values persisted when admitting one installation member. */
export interface AdmitMemberRecord {
  readonly createdAt: string;
  readonly displayName: string;
  readonly email: string;
  readonly id: string;
  readonly installationId: string;
  readonly role: InstallationMember["role"];
}

/** Values persisted when binding one external identity to a member. */
export interface BindExternalIdentityRecord {
  readonly boundAt: string;
  readonly email: string;
  readonly memberId: string;
  readonly provider: string;
  readonly subject: string;
}

/** Values persisted when creating one browser application session. */
export interface CreateApplicationSessionRecord {
  readonly createdAt: string;
  readonly csrfDigest: string;
  readonly expiresAt: string;
  readonly id: string;
  readonly installationId: string;
  readonly memberId: string;
  readonly tokenDigest: string;
}

/** The name shown for one member or API-key principal. */
export interface PrincipalDisplayName {
  readonly displayName: string;
  readonly principalId: string;
}

/** Persistent identity operations required by the Node application composition. */
export interface IdentityRepository {
  admitMember(command: AdmitMemberRecord): Promise<InstallationMember>;
  bindExternalIdentity(command: BindExternalIdentityRecord): Promise<void>;
  consumeLoginAttempt(
    stateDigest: string,
    provider: string,
    consumedAt: string,
  ): Promise<LoginAttempt>;
  createApiKey(key: StoredManagedApiKey): Promise<ManagedApiKey>;
  createApplicationSession(
    command: CreateApplicationSessionRecord,
  ): Promise<ApplicationSession>;
  createLoginAttempt(attempt: LoginAttempt): Promise<void>;
  deactivateMember(
    installationId: string,
    memberId: string,
    updatedAt: string,
  ): Promise<InstallationMember>;
  findActiveMemberByEmail(
    installationId: string,
    email: string,
  ): Promise<InstallationMember | null>;
  findActiveMemberByExternalIdentity(
    installationId: string,
    provider: string,
    subject: string,
  ): Promise<InstallationMember | null>;
  findApiKey(
    installationId: string,
    keyId: string,
  ): Promise<StoredManagedApiKey | null>;
  findApplicationSession(
    installationId: string,
    tokenDigest: string,
    requestTime: string,
  ): Promise<ApplicationSession | null>;
  /**
   * The subject one identity provider bound to a member, or null when the
   * member never signed in through it.
   */
  findExternalSubject(
    installationId: string,
    provider: string,
    memberId: string,
  ): Promise<string | null>;
  findMember(
    installationId: string,
    memberId: string,
  ): Promise<InstallationMember | null>;
  /** Find an admitted email, including inactive members. */
  findMemberByEmail(
    installationId: string,
    email: string,
  ): Promise<InstallationMember | null>;
  /** Find a bound subject, including inactive members. */
  findMemberByExternalIdentity(
    installationId: string,
    provider: string,
    subject: string,
  ): Promise<InstallationMember | null>;
  /**
   * Find the shown name of each listed principal: a member's display name,
   * deactivated members included, or a service key's name, the newest key's
   * when it was rotated (key id breaks a tie). Unknown ids are left out, and
   * so is a member whose display name is their email, which sign-in stores
   * when the provider sends no name: email addresses are never returned.
   */
  findPrincipalDisplayNames(
    installationId: string,
    principalIds: readonly string[],
  ): Promise<readonly PrincipalDisplayName[]>;
  hasMembers(installationId: string): Promise<boolean>;
  listApiKeys(installationId: string): Promise<readonly ManagedApiKey[]>;
  listMembers(installationId: string): Promise<readonly InstallationMember[]>;
  revokeApiKey(
    installationId: string,
    keyId: string,
    revokedAt: string,
  ): Promise<ManagedApiKey>;
  revokeApplicationSession(
    installationId: string,
    tokenDigest: string,
    revokedAt: string,
  ): Promise<void>;
  rotateApiKey(
    installationId: string,
    previousKeyId: string,
    replacement: StoredManagedApiKey,
    revokedAt: string,
  ): Promise<ManagedApiKey>;
}

/** Atomic first-key operation required by private-team composition roots. */
export interface BootstrapManagedApiKeyRepository extends IdentityRepository {
  /** Return the same key, or create it only while the installation has no identity state. */
  initializeBootstrapApiKey(
    key: StoredManagedApiKey,
  ): Promise<StoredManagedApiKey>;
}
