// Minimal, independent CLAP host check for the locally built Element FX.
// Compile with the CLAP headers from the Element source tree. This verifies
// discovery, instance creation and 48 kHz activation; it does not render audio.
#include <clap/clap.h>
#include <clap/ext/audio-ports.h>
#include <dlfcn.h>
#include <cstdio>

static const void* no_extension(const clap_host_t*, const char*) { return nullptr; }
static void no_request(const clap_host_t*) {}

int main(int argc, char** argv) {
  if (argc != 3) {
    std::fprintf(stderr, "usage: clap-smoke <binary> <bundle>\n");
    return 2;
  }
  void* library = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
  if (!library) {
    std::fprintf(stderr, "dlopen: %s\n", dlerror());
    return 3;
  }
  const auto* entry = static_cast<const clap_plugin_entry_t*>(dlsym(library, "clap_entry"));
  if (!entry || !entry->init(argv[2])) return 4;
  const auto* factory = static_cast<const clap_plugin_factory_t*>(entry->get_factory(CLAP_PLUGIN_FACTORY_ID));
  if (!factory || factory->get_plugin_count(factory) != 1) return 5;
  const auto* descriptor = factory->get_plugin_descriptor(factory, 0);
  if (!descriptor) return 6;
  std::printf("descriptor %s | %s\n", descriptor->id, descriptor->name);
  clap_host_t host = {CLAP_VERSION, nullptr, "Squatch smoke host", "Squatch Stack", "", "0.1",
                      no_extension, no_request, no_request, no_request};
  const auto* plugin = factory->create_plugin(factory, &host, descriptor->id);
  if (!plugin) return 7;
  if (!plugin->init(plugin)) { plugin->destroy(plugin); return 8; }
  const auto* ports = static_cast<const clap_plugin_audio_ports_t*>(plugin->get_extension(plugin, CLAP_EXT_AUDIO_PORTS));
  if (!ports) { plugin->destroy(plugin); return 9; }
  std::printf("audio ports %u in, %u out\n", ports->count(plugin, true), ports->count(plugin, false));
  if (!plugin->activate(plugin, 48000, 64, 512)) { plugin->destroy(plugin); return 10; }
  if (!plugin->start_processing(plugin)) { plugin->deactivate(plugin); plugin->destroy(plugin); return 11; }
  plugin->stop_processing(plugin);
  plugin->deactivate(plugin);
  plugin->destroy(plugin);
  entry->deinit();
  dlclose(library);
  std::puts("instantiate and activate OK");
  return 0;
}
