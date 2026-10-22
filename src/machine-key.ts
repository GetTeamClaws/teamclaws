import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as signBytes,
} from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, link, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { TeamClawsError } from "./errors.js";

const execFile = promisify(execFileCallback);

export type PublicMachineJwk = {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
};

export type MachineKeyReference = {
  provider: "windows-cng" | "posix-file";
  name: string;
  public_jwk: PublicMachineJwk;
  jkt: string;
};

export interface MachineKeyProvider {
  create(): Promise<MachineKeyReference>;
  sign(reference: MachineKeyReference, input: string): Promise<string>;
}

export class OsMachineKeyProvider implements MachineKeyProvider {
  private readonly root: string;

  constructor(root?: string) {
    this.root = root ?? join(homedir(), ".teamclaws");
  }

  async create(): Promise<MachineKeyReference> {
    if (process.platform === "linux" || process.platform === "darwin")
      return this.createPosix();
    if (process.platform !== "win32") throw keyUnavailable();
    const name = `teamclaws-cli-${randomUUID()}`;
    const output = await runCng("create", name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(output) as unknown;
    } catch {
      throw keyUnavailable();
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("x" in parsed) ||
      !("y" in parsed) ||
      typeof parsed.x !== "string" ||
      typeof parsed.y !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(parsed.x) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(parsed.y)
    )
      throw keyUnavailable();
    const public_jwk: PublicMachineJwk = {
      kty: "EC",
      crv: "P-256",
      x: parsed.x,
      y: parsed.y,
    };
    return {
      provider: "windows-cng",
      name,
      public_jwk,
      jkt: jwkThumbprint(public_jwk),
    };
  }

  async sign(reference: MachineKeyReference, input: string): Promise<string> {
    if (
      (process.platform === "linux" || process.platform === "darwin") &&
      reference.provider === "posix-file"
    )
      return this.signPosix(reference, input);
    if (process.platform !== "win32" || reference.provider !== "windows-cng")
      throw keyUnavailable();
    if (!/^teamclaws-cli-[0-9a-f-]{36}$/u.test(reference.name))
      throw keyUnavailable();
    const signature = (await runCng("sign", reference.name, input)).trim();
    if (!/^[A-Za-z0-9_-]{86}$/u.test(signature)) throw keyUnavailable();
    return signature;
  }

  private keyDirectory(): string {
    return join(this.root, "machine-keys");
  }

  private async privatePosixDirectory(): Promise<string> {
    const directory = this.keyDirectory();
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await assertPrivateDirectory(this.root);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await assertPrivateDirectory(directory);
      return directory;
    } catch {
      throw keyUnavailable();
    }
  }

  private async createPosix(): Promise<MachineKeyReference> {
    const directory = await this.privatePosixDirectory();
    const name = `teamclaws-cli-${randomUUID()}`;
    const temporary = join(directory, `.${name}.tmp`);
    const destination = join(directory, `${name}.pem`);
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const public_jwk = publicKey.export({ format: "jwk" }) as PublicMachineJwk;
    const pem = privateKey.export({ type: "pkcs8", format: "pem" });
    let handle;
    let linked = false;
    try {
      handle = await open(
        temporary,
        fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_WRONLY |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(pem);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await assertPrivateFile(temporary);
      await link(temporary, destination);
      linked = true;
      await unlink(temporary);
      const directoryHandle = await open(
        directory,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
      return {
        provider: "posix-file",
        name,
        public_jwk,
        jkt: jwkThumbprint(public_jwk),
      };
    } catch {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      if (linked) await unlink(destination).catch(() => undefined);
      throw keyUnavailable();
    }
  }

  private async signPosix(
    reference: MachineKeyReference,
    input: string,
  ): Promise<string> {
    if (!/^teamclaws-cli-[0-9a-f-]{36}$/u.test(reference.name))
      throw keyUnavailable();
    try {
      await assertPrivateDirectory(this.root);
      await assertPrivateDirectory(this.keyDirectory());
      const path = join(this.keyDirectory(), `${reference.name}.pem`);
      const handle = await open(
        path,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      let pem: Buffer;
      try {
        const info = await handle.stat();
        if (
          !info.isFile() ||
          info.uid !== process.getuid?.() ||
          (info.mode & 0o777) !== 0o600 ||
          info.size > 8192
        )
          throw keyUnavailable();
        pem = await handle.readFile();
      } finally {
        await handle.close();
      }
      const privateKey = createPrivateKey(pem);
      const actualJwk = createPublicKey(privateKey).export({
        format: "jwk",
      }) as PublicMachineJwk;
      if (
        jwkThumbprint(actualJwk) !== reference.jkt ||
        actualJwk.x !== reference.public_jwk.x ||
        actualJwk.y !== reference.public_jwk.y
      )
        throw keyUnavailable();
      return signBytes("sha256", Buffer.from(input, "ascii"), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url");
    } catch {
      throw keyUnavailable();
    }
  }
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o700
  )
    throw keyUnavailable();
}

async function assertPrivateFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o600
  )
    throw keyUnavailable();
}

export function jwkThumbprint(jwk: PublicMachineJwk): string {
  return createHash("sha256")
    .update(
      JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }),
      "ascii",
    )
    .digest("base64url");
}

// The named CNG key is scoped to the Windows user and is never exportable.
// Only public coordinates and signatures leave CNG. No private JWK is serialized.
const cngScript = String.raw`
$ErrorActionPreference = 'Stop'
$provider = [System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider
if ($operation -eq 'create') {
  $parameters = New-Object System.Security.Cryptography.CngKeyCreationParameters
  $parameters.Provider = $provider
  $parameters.KeyUsage = [System.Security.Cryptography.CngKeyUsages]::Signing
  $parameters.ExportPolicy = [System.Security.Cryptography.CngExportPolicies]::None
  $key = [System.Security.Cryptography.CngKey]::Create([System.Security.Cryptography.CngAlgorithm]::ECDsaP256, $keyName, $parameters)
  try {
    $ecdsa = New-Object System.Security.Cryptography.ECDsaCng($key)
    try {
      $point = $ecdsa.ExportParameters($false).Q
      $x = [Convert]::ToBase64String($point.X).TrimEnd('=').Replace('+','-').Replace('/','_')
      $y = [Convert]::ToBase64String($point.Y).TrimEnd('=').Replace('+','-').Replace('/','_')
      Write-Output ('{"x":"' + $x + '","y":"' + $y + '"}')
    } finally { $ecdsa.Dispose() }
  } finally { $key.Dispose() }
} elseif ($operation -eq 'sign') {
  $key = [System.Security.Cryptography.CngKey]::Open($keyName, $provider)
  try {
    $ecdsa = New-Object System.Security.Cryptography.ECDsaCng($key)
    try {
      $hash = [System.Security.Cryptography.SHA256]::Create()
      try { $digest = $hash.ComputeHash([Text.Encoding]::ASCII.GetBytes($signingInput)) }
      finally { $hash.Dispose() }
      $signature = $ecdsa.SignHash($digest)
      Write-Output ([Convert]::ToBase64String($signature).TrimEnd('=').Replace('+','-').Replace('/','_'))
    } finally { $ecdsa.Dispose() }
  } finally { $key.Dispose() }
} else { throw 'Unsupported machine key operation' }
`;

async function runCng(
  operation: string,
  name: string,
  input?: string,
): Promise<string> {
  try {
    if (
      !/^(create|sign)$/u.test(operation) ||
      !/^teamclaws-cli-[0-9a-f-]{36}$/u.test(name) ||
      (input !== undefined && !/^[A-Za-z0-9_.-]{1,4096}$/u.test(input))
    )
      throw keyUnavailable();
    const script = `$operation='${operation}'\n$keyName='${name}'\n$signingInput='${input ?? ""}'\n${cngScript}`;
    const { stdout } = await execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        ConvertScript(script),
      ],
      { encoding: "utf8", windowsHide: true, maxBuffer: 4096 },
    );
    return stdout.trim();
  } catch {
    throw keyUnavailable();
  }
}

function ConvertScript(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function keyUnavailable(): TeamClawsError {
  return new TeamClawsError(
    "machine_key_unavailable",
    "A protected machine key is required for CLI authorization.",
    { exitCode: 9 },
  );
}
