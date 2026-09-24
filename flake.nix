{
  description = "scrivener: Discord voice-call recorder and per-speaker transcriber";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: rec {
        scrivener = pkgs.callPackage ./nix/package.nix { };
        # The OCI image is the default, matching the fleet's container payloads.
        image = pkgs.callPackage ./nix/image.nix { inherit scrivener; };
        default = image;
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_22
            pkgs.ffmpeg-headless
            pkgs.espeak-ng
            self.packages.${pkgs.system}.scrivener.passthru.python
          ];
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt-rfc-style);
    };
}
