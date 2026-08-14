namespace LitMTransPort {
  export interface MigrationIdentity {
    pythonFile: string; className: string; functionName: string; sourceLines: string;
    targetFile: string; targetFunction: string; status: string;
  }
  export function migrationIdentityKey(identity: Pick<MigrationIdentity, "pythonFile" | "className" | "functionName">): string {
    return [identity.pythonFile, identity.className, identity.functionName].filter(Boolean).join("::");
  }
  export function validateMigrationIdentity(identity: MigrationIdentity): string[] {
    const errors: string[] = [];
    if (!identity.pythonFile) errors.push("pythonFile");
    if (!identity.functionName && !identity.className) errors.push("symbol");
    if (!identity.targetFile) errors.push("targetFile");
    if (!identity.status) errors.push("status");
    return errors;
  }
  export function snakeToCamel(value: string): string {
    return String(value || "").replace(/_([a-z0-9])/g, (_match, char) => String(char).toUpperCase()).replace(/^_+/, "");
  }
}
