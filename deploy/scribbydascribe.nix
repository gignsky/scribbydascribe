# scribbydascribe: Discord voice-call recorder and per-speaker transcriber, run as
# a service on spacedock. Drop this file into `containers/services/` in
# .dotfiles and import it from `containers/services/default.nix`.
#
# The image comes from the `scribbydascribe` flake input (a
# `dockerTools.buildLayeredImage` tarball tagged `scribbydascribe:latest`), the same
# way avec-moi-app.nix does it.
#
# Before the first switch:
#   1. Add to nix-secrets/secrets.yaml (`just sops`) a key `scribbydascribe-env`
#      whose value is an env file:
#        DISCORD_TOKEN=<bot token>
#        DISCORD_GUILD_ID=<server id>   # optional: instant command registration
#      validateSopsFiles is on, so the build fails until the key exists.
#   2. Add the flake input in flake.nix:
#        scribbydascribe = {
#          url = "github:gignsky/scribbydascribe/master";
#          inputs.nixpkgs.follows = "nixpkgs";
#        };
#
# Session folders land in /var/lib/scribbydascribe/sessions; the Whisper model
# downloads once into /var/lib/scribbydascribe/models on first start, and the
# /scribe transpose speaker-embedding model the first time any server splits
# a shared mic.
{
  config,
  inputs,
  lib,
  pkgs,
  ...
}:
let
  imageFile = inputs.scribbydascribe.packages.${pkgs.system}.default;
in
{
  sops.secrets.scribbydascribe-env = { };

  systemd.tmpfiles.rules = [ "d /var/lib/scribbydascribe 0750 root root -" ];

  virtualisation.oci-containers.containers.scribbydascribe = {
    inherit imageFile;
    image = "scribbydascribe:latest";
    autoStart = true;
    environmentFiles = [ config.sops.secrets.scribbydascribe-env.path ];
    environment = {
      TZ = "America/New_York";
      # spacedock's Polaris GPU has no CUDA, so Whisper runs on the CPU.
      # "small" keeps up with a lively call on a few cores; "medium" is more
      # accurate but roughly 3x slower. Sessions finish either way: clips that
      # arrive faster than they transcribe just queue.
      WHISPER_MODEL = "small";
      WHISPER_DEVICE = "cpu";
      WHISPER_COMPUTE_TYPE = "int8";
      WHISPER_LANGUAGE = "en";
    };
    volumes = [ "/var/lib/scribbydascribe:/data" ];
    # On stop the bot suspends any recording in progress and carries on with
    # it when it starts again (a `nix flake update scribbydascribe` + switch is a
    # restart), which takes a few seconds. With
    # SCRIBBYDASCRIBE_RESUME_AFTER_RESTART=false it instead finishes each one
    # (drains the transcription queue, writes the files, posts the
    # transcript) before exiting, so give it time rather than the default 10 s.
    extraOptions = [ "--stop-timeout=600" ];
  };

  systemd.services.podman-scribbydascribe.serviceConfig.TimeoutStopSec = lib.mkForce 660;
}
