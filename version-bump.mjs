import fs from "fs";
import path from "path";

const manifestPath = path.join(process.cwd(), "manifest.json");
const versionsPath = path.join(process.cwd(), "versions.json");

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const versions = JSON.parse(fs.readFileSync(versionsPath, "utf8"));

versions[manifest.version] = manifest.minAppVersion;

fs.writeFileSync(versionsPath, JSON.stringify(versions, null, 2) + "\n");
console.log(`Updated versions.json for ${manifest.version}`);
