#include "my_application.h"

#include <flutter_linux/flutter_linux.h>
#include <gtk/gtk.h>
#ifdef GDK_WINDOWING_X11
#include <gdk/gdkx.h>
#endif

#include "flutter/generated_plugin_registrant.h"

struct _MyApplication {
  GtkApplication parent_instance;
  char** dart_entrypoint_arguments;
};

G_DEFINE_TYPE(MyApplication, my_application, GTK_TYPE_APPLICATION)

// Called when first Flutter frame received.
static void first_frame_cb(MyApplication* self, FlView* view) {
  gtk_widget_show(gtk_widget_get_toplevel(GTK_WIDGET(view)));
}

// Reads a native image off the GTK clipboard, as PNG bytes.
static FlMethodResponse* read_clipboard_image_png() {
  GtkClipboard* clipboard = gtk_clipboard_get(GDK_SELECTION_CLIPBOARD);
  GdkPixbuf* pixbuf = gtk_clipboard_wait_for_image(clipboard);
  if (pixbuf == nullptr) {
    // No image on the clipboard (the normal case for a plain-text paste) — the Dart side falls
    // back to today's text-paste behaviour.
    return FL_METHOD_RESPONSE(fl_method_success_response_new(fl_value_new_null()));
  }

  gchar* buffer = nullptr;
  gsize buffer_size = 0;
  g_autoptr(GError) error = nullptr;
  FlMethodResponse* response;
  if (gdk_pixbuf_save_to_buffer(pixbuf, &buffer, &buffer_size, "png", &error, nullptr)) {
    g_autoptr(FlValue) bytes = fl_value_new_uint8_list(
        reinterpret_cast<const uint8_t*>(buffer), buffer_size);
    response = FL_METHOD_RESPONSE(fl_method_success_response_new(bytes));
    g_free(buffer);
  } else {
    response = FL_METHOD_RESPONSE(fl_method_error_response_new(
        "ENCODE_FAILED",
        error != nullptr ? error->message : "failed to encode the clipboard image as PNG",
        nullptr));
  }
  g_object_unref(pixbuf);
  return response;
}

// Writes PNG bytes onto the GTK clipboard, replacing whatever was there — the LOCAL half of
// native image drag-drop (`_dropImage` in pane_grid.dart): when the pane's machine is this same
// computer, the app puts the dropped image on ITS OWN clipboard directly instead of sending it
// over the terminal wire, then forwards a Ctrl+V so the engine reads it exactly as it already
// does for an ordinary local clipboard paste. GTK's clipboard API works in terms of a decoded
// GdkPixbuf, not raw encoded bytes, unlike the read side above (which can hand back raw PNG bytes
// directly) — hence decoding through a loader here.
static FlMethodResponse* write_clipboard_image_png(FlValue* args) {
  if (args == nullptr || fl_value_get_type(args) != FL_VALUE_TYPE_UINT8_LIST) {
    return FL_METHOD_RESPONSE(fl_method_error_response_new(
        "INVALID_ARGUMENT", "expected PNG bytes", nullptr));
  }
  const uint8_t* bytes = fl_value_get_uint8_list(args);
  size_t length = fl_value_get_length(args);

  g_autoptr(GdkPixbufLoader) loader = gdk_pixbuf_loader_new();
  gdk_pixbuf_loader_write(loader, bytes, length, nullptr);
  gdk_pixbuf_loader_close(loader, nullptr);
  GdkPixbuf* pixbuf = gdk_pixbuf_loader_get_pixbuf(loader);
  if (pixbuf == nullptr) {
    return FL_METHOD_RESPONSE(fl_method_success_response_new(fl_value_new_bool(FALSE)));
  }

  GtkClipboard* clipboard = gtk_clipboard_get(GDK_SELECTION_CLIPBOARD);
  gtk_clipboard_set_image(clipboard, pixbuf);
  return FL_METHOD_RESPONSE(fl_method_success_response_new(fl_value_new_bool(TRUE)));
}

// Dart calls into this channel to read/write a native image on the GTK clipboard. Flutter's own
// `Clipboard` API only ever sees text/plain — see terminal_panel.dart's `_paste()` — so a real
// image (a screenshot, "Copy Image" from a browser, ...) needs this native round trip instead.
// Mirrors macOS's `harness/clipboard_image` channel (MainFlutterWindow.swift).
static void clipboard_image_method_call_cb(FlMethodChannel* channel,
                                            FlMethodCall* method_call,
                                            gpointer user_data) {
  g_autoptr(FlMethodResponse) response = nullptr;
  const gchar* method = fl_method_call_get_name(method_call);
  if (g_strcmp0(method, "readImagePng") == 0) {
    response = read_clipboard_image_png();
  } else if (g_strcmp0(method, "writeImagePng") == 0) {
    response = write_clipboard_image_png(fl_method_call_get_args(method_call));
  } else {
    response = FL_METHOD_RESPONSE(fl_method_not_implemented_response_new());
  }
  fl_method_call_respond(method_call, response, nullptr);
}

// Held for the app's lifetime (same scope as the window itself), never unreffed — there is no
// natural teardown point before process exit, the same reason `fl_register_plugins` below registers
// its plugins on `view` with no matching cleanup in this function.
static void install_clipboard_image_channel(FlView* view) {
  FlMethodChannel* channel = fl_method_channel_new(
      fl_engine_get_binary_messenger(fl_view_get_engine(view)), "harness/clipboard_image",
      FL_METHOD_CODEC(fl_standard_method_codec_new()));
  fl_method_channel_set_method_call_handler(
      channel, clipboard_image_method_call_cb, nullptr, nullptr);
}

// Implements GApplication::activate.
static void my_application_activate(GApplication* application) {
  MyApplication* self = MY_APPLICATION(application);

  // Harness Desktop is dark-only. Left alone, GTK's header bar and chrome
  // follow whatever theme preference the desktop environment has configured;
  // this pins it so native chrome matches the app's own (dark-only) palette
  // regardless of that setting.
  g_object_set(gtk_settings_get_default(), "gtk-application-prefer-dark-theme",
               TRUE, NULL);

  GtkWindow* window =
      GTK_WINDOW(gtk_application_window_new(GTK_APPLICATION(application)));

  // The packaged icon lives beside the executable in the relocatable Linux
  // bundle. Resolve it once so both the native window icon and GNOME's custom
  // header title use the exact same asset.
  g_autofree gchar* icon_path = nullptr;
  g_autofree gchar* exe_path = g_file_read_link("/proc/self/exe", nullptr);
  if (exe_path != nullptr) {
    g_autofree gchar* exe_dir = g_path_get_dirname(exe_path);
    icon_path = g_build_filename(exe_dir, "harness.png", nullptr);
  }

  // Use a header bar when running in GNOME as this is the common style used
  // by applications and is the setup most users will be using (e.g. Ubuntu
  // desktop).
  // If running on X and not using GNOME then just use a traditional title bar
  // in case the window manager does more exotic layout, e.g. tiling.
  // If running on Wayland assume the header bar will work (may need changing
  // if future cases occur).
  gboolean use_header_bar = TRUE;
#ifdef GDK_WINDOWING_X11
  GdkScreen* screen = gtk_window_get_screen(window);
  if (GDK_IS_X11_SCREEN(screen)) {
    const gchar* wm_name = gdk_x11_screen_get_window_manager_name(screen);
    if (g_strcmp0(wm_name, "GNOME Shell") != 0) {
      use_header_bar = FALSE;
    }
  }
#endif
  if (use_header_bar) {
    GtkHeaderBar* header_bar = GTK_HEADER_BAR(gtk_header_bar_new());
    gtk_widget_show(GTK_WIDGET(header_bar));
    // GTK's stock header title has no application icon. Supply a compact,
    // centered title widget so the native caption identifies Harness the same
    // way it does in the dock and task switcher.
    GtkWidget* title = gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 6);
    if (icon_path != nullptr && g_file_test(icon_path, G_FILE_TEST_IS_REGULAR)) {
      g_autoptr(GError) icon_error = nullptr;
      g_autoptr(GdkPixbuf) title_pixbuf = gdk_pixbuf_new_from_file_at_scale(
          icon_path, 20, 20, TRUE, &icon_error);
      if (title_pixbuf != nullptr) {
        GtkWidget* icon = gtk_image_new_from_pixbuf(title_pixbuf);
        gtk_box_pack_start(GTK_BOX(title), icon, FALSE, FALSE, 0);
      }
    }
    GtkWidget* label = gtk_label_new("Harness");
    gtk_box_pack_start(GTK_BOX(title), label, FALSE, FALSE, 0);
    gtk_widget_show_all(title);
    gtk_header_bar_set_custom_title(header_bar, title);
    gtk_header_bar_set_show_close_button(header_bar, TRUE);
    gtk_window_set_titlebar(window, GTK_WIDGET(header_bar));
  }
  // Keep the native window metadata correct even when a custom header is
  // drawn. Window managers use it for non-GNOME captions and accessibility.
  gtk_window_set_title(window, "Harness");

  gtk_window_set_default_size(window, 1280, 720);

  // App icon — installed at the bundle root next to the executable by
  // linux/CMakeLists.txt's install() rule (a stock `flutter create` scaffold
  // has no icon wired in at all).
  if (icon_path != nullptr) {
    gtk_window_set_icon_from_file(window, icon_path, nullptr);
  }

  g_autoptr(FlDartProject) project = fl_dart_project_new();
  fl_dart_project_set_dart_entrypoint_arguments(
      project, self->dart_entrypoint_arguments);

  FlView* view = fl_view_new(project);
  GdkRGBA background_color;
  // Background defaults to black, override it here if necessary, e.g. #00000000
  // for transparent.
  gdk_rgba_parse(&background_color, "#000000");
  fl_view_set_background_color(view, &background_color);
  gtk_widget_show(GTK_WIDGET(view));
  gtk_container_add(GTK_CONTAINER(window), GTK_WIDGET(view));

  // Show the window when Flutter renders.
  // Requires the view to be realized so we can start rendering.
  g_signal_connect_swapped(view, "first-frame", G_CALLBACK(first_frame_cb),
                           self);
  gtk_widget_realize(GTK_WIDGET(view));

  fl_register_plugins(FL_PLUGIN_REGISTRY(view));
  install_clipboard_image_channel(view);

  gtk_widget_grab_focus(GTK_WIDGET(view));
}

// Implements GApplication::local_command_line.
static gboolean my_application_local_command_line(GApplication* application,
                                                  gchar*** arguments,
                                                  int* exit_status) {
  MyApplication* self = MY_APPLICATION(application);
  // Strip out the first argument as it is the binary name.
  self->dart_entrypoint_arguments = g_strdupv(*arguments + 1);

  g_autoptr(GError) error = nullptr;
  if (!g_application_register(application, nullptr, &error)) {
    g_warning("Failed to register: %s", error->message);
    *exit_status = 1;
    return TRUE;
  }

  g_application_activate(application);
  *exit_status = 0;

  return TRUE;
}

// Implements GApplication::startup.
static void my_application_startup(GApplication* application) {
  // MyApplication* self = MY_APPLICATION(object);

  // Perform any actions required at application startup.

  G_APPLICATION_CLASS(my_application_parent_class)->startup(application);
}

// Implements GApplication::shutdown.
static void my_application_shutdown(GApplication* application) {
  // MyApplication* self = MY_APPLICATION(object);

  // Perform any actions required at application shutdown.

  G_APPLICATION_CLASS(my_application_parent_class)->shutdown(application);
}

// Implements GObject::dispose.
static void my_application_dispose(GObject* object) {
  MyApplication* self = MY_APPLICATION(object);
  g_clear_pointer(&self->dart_entrypoint_arguments, g_strfreev);
  G_OBJECT_CLASS(my_application_parent_class)->dispose(object);
}

static void my_application_class_init(MyApplicationClass* klass) {
  G_APPLICATION_CLASS(klass)->activate = my_application_activate;
  G_APPLICATION_CLASS(klass)->local_command_line =
      my_application_local_command_line;
  G_APPLICATION_CLASS(klass)->startup = my_application_startup;
  G_APPLICATION_CLASS(klass)->shutdown = my_application_shutdown;
  G_OBJECT_CLASS(klass)->dispose = my_application_dispose;
}

static void my_application_init(MyApplication* self) {}

MyApplication* my_application_new() {
  // Set the program name to the application ID, which helps various systems
  // like GTK and desktop environments map this running application to its
  // corresponding .desktop file. This ensures better integration by allowing
  // the application to be recognized beyond its binary name.
  g_set_prgname(APPLICATION_ID);

  return MY_APPLICATION(g_object_new(my_application_get_type(),
                                     "application-id", APPLICATION_ID, "flags",
                                     G_APPLICATION_NON_UNIQUE, nullptr));
}
