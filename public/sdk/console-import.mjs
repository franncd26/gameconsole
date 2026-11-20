export class PluginImportView {
  constructor({ document, api, onInstalled }) {
    Object.assign(this, { document, api, onInstalled }); this.listeners = []; this.busy = false;
    for (const id of ['import-game', 'import-file', 'import-details', 'import-confirm', 'import-status']) this[id] = document.getElementById(id);
    this.listen(this['import-game'], 'click', () => { this['import-file'].value = ''; this['import-file'].click(); });
    this.listen(this['import-file'], 'change', () => void this.preview());
    this.listen(this['import-confirm'], 'click', () => void this.confirm());
  }
  listen(node, type, fn) { node.addEventListener(type, fn); this.listeners.push(() => node.removeEventListener(type, fn)); }
  async init() {
    if (!this.api.importStatus) return;
    try {
      const status = await this.api.importStatus();
      if (!this.disposed) {
        this['import-game'].hidden = !status.enabled;
        this.document.getElementById('plugin-importer').hidden = !status.enabled;
        if (status.issues?.length) this['import-status'].textContent = 'Algunos paquetes no se recuperaron: ' + status.issues.map(i => i.id).join(', ') + '. Los juegos originales siguen disponibles.';
      }
    }
    catch { /* Academic mode never depends on importer availability. */ }
  }
  async preview() {
    if (this.busy || this.disposed) return;
    const file = this['import-file'].files?.[0]; if (!file) return;
    this.token = null; this['import-confirm'].hidden = true;
    if (!file.name.endsWith('.game.zip') || file.size > 10 * 1024 * 1024) { this['import-status'].textContent = 'Selecciona un .game.zip de hasta 10 MiB.'; return; }
    this.busy = true; this['import-game'].disabled = true; this['import-status'].textContent = 'Verificando archivos y manifiesto…';
    try {
      const value = await this.api.previewPlugin(file); if (this.disposed) return;
      this.token = value.token; const m = value.manifest;
      this['import-details'].textContent = m.name + ' · ' + m.version + ' — ' + m.description + '\nInstala solo paquetes de confianza: su servidor ejecutará código Node con los permisos de GameConsole.';
      this['import-confirm'].hidden = false; this['import-status'].textContent = 'Revisa el paquete y confirma su instalación.';
    } catch (e) { if (!this.disposed) this['import-status'].textContent = e.message; }
    finally { this.busy = false; this['import-game'].disabled = false; }
  }
  async confirm() {
    if (this.busy || !this.token || this.disposed) return;
    this.busy = true; this['import-confirm'].disabled = true; this['import-game'].disabled = true; this['import-status'].textContent = 'Instalando y esperando la verificación analítica de Scala…';
    try {
      await this.api.installPlugin(this.token); if (this.disposed) return;
      this.token = null; this['import-confirm'].hidden = true; this['import-status'].textContent = 'Juego instalado. Perfil analítico verificado. Ya puedes crear partidas.';
      await this.onInstalled();
    } catch (e) { if (!this.disposed) this['import-status'].textContent = e.message + ' Si se perdió la respuesta, actualiza la biblioteca antes de volver a importar.'; }
    finally { this.busy = false; this['import-confirm'].disabled = false; this['import-game'].disabled = false; }
  }
  dispose() { this.disposed = true; for (const off of this.listeners) off(); }
}
