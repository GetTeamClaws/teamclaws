import process from "node:process";

if (Number(process.versions.node.split(".")[0]) < 22) {
  process.stderr.write(
    `TeamClaws requires Node.js 22 or newer; this runtime is ${process.versions.node}. Upgrade Node.js before installing TeamClaws.\n`,
  );
  process.exitCode = 1;
}
