{
  dockerTools,
  cacert,
  tzdata,
  scribbydascribe,
}:
# OCI image for spacedock's podman: `podman load < result`, tagged
# scribbydascribe:latest. Sessions and the downloaded Whisper model live on the
# /data volume so they survive image upgrades.
dockerTools.buildLayeredImage {
  name = "scribbydascribe";
  tag = "latest";
  contents = [
    scribbydascribe
    cacert
    tzdata
  ];
  extraCommands = ''
    mkdir -p data tmp
    chmod 1777 tmp
  '';
  config = {
    Entrypoint = [ "${scribbydascribe}/bin/scribbydascribe" ];
    Env = [
      "SSL_CERT_FILE=${cacert}/etc/ssl/certs/ca-bundle.crt"
      "SCRIBBYDASCRIBE_DATA_DIR=/data/sessions"
      "HF_HOME=/data/models"
      "TZ=America/New_York"
    ];
    Volumes."/data" = { };
    StopSignal = "SIGTERM";
  };
}
