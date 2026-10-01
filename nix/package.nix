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
  # speechbrain (a speaker-embedding model, for /scribe transpose's party
  # mode) is loaded lazily and only on the first clip that needs it, so a
  # server that never splits a mic never pays for it at startup.
  python = python3.withPackages (ps: [ ps.faster-whisper ps.speechbrain ]);
  root = ../.;
in
buildNpmPackage {
  pname = "scribbydascribe";
  version = "0.1.1";

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
    export SCRIBBYDASCRIBE_SKIP_E2E=1
    node --test test/*.test.js
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/scribbydascribe $out/bin
    cp -r package.json src worker node_modules $out/lib/scribbydascribe/
    makeWrapper ${nodejs_22}/bin/node $out/bin/scribbydascribe \
      --add-flags $out/lib/scribbydascribe/src/index.js \
      --set-default SCRIBBYDASCRIBE_PYTHON ${python}/bin/python3 \
      --set-default SCRIBBYDASCRIBE_FFMPEG ${ffmpeg-headless}/bin/ffmpeg
    runHook postInstall
  '';

  passthru = { inherit python; };

  meta = {
    description = "Discord bot that records a voice call and writes a per-speaker, timestamped transcript";
    mainProgram = "scribbydascribe";
    platforms = lib.platforms.linux;
  };
}
