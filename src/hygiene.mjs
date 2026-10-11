/** Remove only what this tool created (everything it makes carries a cc.* label). It never prunes: the daemon may hold other people's containers, images and volumes. */
import { spawnSync } from "node:child_process";
import { dockerEnv } from "./container.mjs";

const sh = (docker, args) => spawnSync(docker, args, { env: dockerEnv(), encoding: "utf8" });
const ids = (docker, args) => (sh(docker, args).stdout || "").split("\n").map((x) => x.trim()).filter((x) => /^[a-f0-9]{6,64}$/.test(x));

export function cleanup({ docker, images = false }) {
  const containers = ids(docker, ["ps", "-aq", "--filter", "label=cc.run"]);
  for (const c of containers) sh(docker, ["rm", "-fv", c]);
  let removedImages = [];
  if (images) {
    removedImages = [...new Set([...ids(docker, ["images", "-q", "--filter", "label=cc.lock"]), ...ids(docker, ["images", "-q", "--filter", "label=cc.requirements"])])];
    for (const i of removedImages) sh(docker, ["rmi", i]);
  }
  return { containers: containers.length, images: removedImages.length };
}
