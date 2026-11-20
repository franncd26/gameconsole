FROM gameconsole-gamestats-scala:local
COPY --chmod=755 deployment/importer/scala-supervisor.sh /app/importer-supervisor.sh
ENTRYPOINT ["/bin/sh", "/app/importer-supervisor.sh"]
