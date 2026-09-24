{
  lib,
  buildNpmPackage,
  nodejs_22,
  python3,
  ffmpeg-headless,
  makeWrapper,
  autoPatchelfHook,
  stdenv,
}:
let
  python = python3.withPackages (ps: [ ps.faster-whisper ]);
  root = ../.;
in
buildNpmPackage {
  pname = "scrivener";
  version = "0.1.0";

  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      ../src
      ../worker
      ../test
    ];
  };

  nodejs = nodejs_22;
  npmDepsHash = "sha256-BNVVqERSfoPW28+DptW5vZSlh/XFqR8bfFMQNf8hOC4=";
  dontNpmBuild = true;

  # @snazzah/davey (Discord's DAVE end-to-end encryption) ships a prebuilt
  # native module that wants libgcc_s.
  nativeBuildInputs = [
    makeWrapper
    autoPatchelfHook
  ];
  buildInputs = [ stdenv.cc.cc.lib ];

  # Unit tests. The speech round trip needs to download a Whisper model, which
  # the build sandbox cannot, so it is left to `npm test` in the dev shell.
  doCheck = true;
  nativeCheckInputs = [ ffmpeg-headless ];
  checkPhase = ''
    runHook preCheck
    export SCRIVENER_SKIP_E2E=1
    node --test test/*.test.js
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/scrivener $out/bin
    cp -r package.json src worker node_modules $out/lib/scrivener/
    makeWrapper ${nodejs_22}/bin/node $out/bin/scrivener \
      --add-flags $out/lib/scrivener/src/index.js \
      --set-default SCRIVENER_PYTHON ${python}/bin/python3 \
      --set-default SCRIVENER_FFMPEG ${ffmpeg-headless}/bin/ffmpeg
    runHook postInstall
  '';

  passthru = { inherit python; };

  meta = {
    description = "Discord bot that records a voice call and writes a per-speaker, timestamped transcript";
    mainProgram = "scrivener";
    platforms = lib.platforms.linux;
  };
}
