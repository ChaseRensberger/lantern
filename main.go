package main

import (
	"embed"
	"log"
	"log/slog"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"lantern/internal/desktop"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	service, err := desktop.New()
	if err != nil {
		log.Fatal(err)
	}
	app := application.New(application.Options{
		Name: "Lantern", Description: "Standalone debugger", LogLevel: slog.LevelWarn,
		Services:   []application.Service{application.NewService(service)},
		Assets:     application.AssetOptions{Handler: application.AssetFileServerFS(mustAssets())},
		Mac:        application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: true},
		ShouldQuit: func() bool { return desktop.RequestClose(service) },
		OnShutdown: func() { desktop.Shutdown(service) },
	})
	desktop.Attach(service, app)
	window := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: "Lantern", Width: 1440, Height: 940, MinWidth: 640, MinHeight: 480, URL: "/",
	})
	window.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
		if !desktop.RequestClose(service) {
			event.Cancel()
		}
	})
	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
