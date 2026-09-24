{
  dockerTools,
  cacert,
  tzdata,
  scrivener,
}:
# OCI image for spacedock's podman: `podman load < result`, tagged
# scrivener:latest. Sessions and the downloaded Whisper model live on the
# /data volume so they survive image upgrades.
dockerTools.buildLayeredImage {
  name = "scrivener";
  tag = "latest";
  contents = [
    scrivener
    cacert
    tzdata
  ];
  extraCommands = ''
    mkdir -p data tmp
    chmod 1777 tmp
  '';
  config = {
    Entrypoint = [ "${scrivener}/bin/scrivener" ];
    Env = [
      "SSL_CERT_FILE=${cacert}/etc/ssl/certs/ca-bundle.crt"
      "SCRIVENER_DATA_DIR=/data/sessions"
      "HF_HOME=/data/models"
      "TZ=America/New_York"
    ];
    Volumes."/data" = { };
    StopSignal = "SIGTERM";
  };
}
