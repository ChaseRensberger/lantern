// Package desktop adapts the shell-independent debugger to Wails bindings.
package desktop

import (
	"context"
	"errors"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/google/go-dap"
	"github.com/wailsapp/wails/v3/pkg/application"
	"lantern/internal/debugger"
	"lantern/internal/settings"
)

type Service struct {
	manager  *debugger.Manager
	settings *settings.Store
	app      *application.App
	quitting atomic.Bool
}

type Info struct {
	OS      string `json:"os"`
	Delve   string `json:"delve"`
	Version string `json:"version"`
}

func New() (*Service, error) {
	path, err := settings.DefaultPath()
	if err != nil {
		return nil, err
	}
	s := &Service{settings: settings.New(path)}
	s.manager = debugger.NewManager()
	return s, nil
}

// Shell lifecycle functions are not methods, so Wails cannot expose them as
// frontend-callable service bindings.
func Attach(s *Service, app *application.App) { s.app = app }

func (s *Service) Info() Info {
	path, _ := exec.LookPath("dlv")
	return Info{OS: runtime.GOOS, Delve: path, Version: "0.1.0-dev"}
}

func (s *Service) LoadSettings() (settings.Data, error)  { return s.settings.Load() }
func (s *Service) SaveSettings(data settings.Data) error { return s.settings.Save(data) }
func (s *Service) Sessions() []debugger.Snapshot         { return s.manager.Snapshots() }
func (s *Service) Start(config debugger.LaunchConfig) (debugger.Snapshot, error) {
	return s.manager.Start(config)
}
func (s *Service) Remove(id string) error { return s.manager.Remove(id) }

func (s *Service) Threads(ctx context.Context, ref debugger.StopRef) ([]dap.Thread, error) {
	session, err := s.manager.Session(ref.SessionID)
	if err != nil {
		return nil, err
	}
	return session.Threads(ctx, ref)
}
func (s *Service) Stack(ctx context.Context, ref debugger.StopRef, threadID int) ([]dap.StackFrame, error) {
	session, err := s.manager.Session(ref.SessionID)
	if err != nil {
		return nil, err
	}
	return session.Stack(ctx, ref, threadID)
}
func (s *Service) Scopes(ctx context.Context, ref debugger.StopRef, frameID int) ([]dap.Scope, error) {
	session, err := s.manager.Session(ref.SessionID)
	if err != nil {
		return nil, err
	}
	return session.Scopes(ctx, ref, frameID)
}
func (s *Service) Variables(ctx context.Context, ref debugger.StopRef, reference, start int, filter string) (debugger.VariablePage, error) {
	session, err := s.manager.Session(ref.SessionID)
	if err != nil {
		return debugger.VariablePage{}, err
	}
	return session.Variables(ctx, ref, reference, start, filter)
}
func (s *Service) Evaluate(ctx context.Context, ref debugger.StopRef, frameID int, expression string) (dap.EvaluateResponseBody, error) {
	session, err := s.manager.Session(ref.SessionID)
	if err != nil {
		return dap.EvaluateResponseBody{}, err
	}
	return session.Evaluate(ctx, ref, frameID, expression)
}
func (s *Service) Execute(ctx context.Context, ref debugger.StopRef, command string, threadID int) error {
	session, err := s.manager.Session(ref.SessionID)
	if err != nil {
		return err
	}
	return session.Execute(ctx, ref, command, threadID)
}
func (s *Service) Breakpoints(ctx context.Context, id, path string, items []debugger.Breakpoint) ([]debugger.Breakpoint, error) {
	session, err := s.manager.Session(id)
	if err != nil {
		return nil, err
	}
	return session.SetBreakpoints(ctx, path, items)
}
func (s *Service) Source(id, path string) (debugger.SourceFile, error) {
	session, err := s.manager.Session(id)
	if err != nil {
		return debugger.SourceFile{}, err
	}
	return session.ReadSource(path)
}
func (s *Service) Files(id string) (debugger.FileList, error) {
	session, err := s.manager.Session(id)
	if err != nil {
		return debugger.FileList{}, err
	}
	return session.Files()
}
func (s *Service) Disconnect(ctx context.Context, id string, terminate bool) error {
	session, err := s.manager.Session(id)
	if err != nil {
		return err
	}
	return session.Disconnect(ctx, terminate)
}

func (s *Service) OpenInEditor(id, path string, line int) error {
	session, err := s.manager.Session(id)
	if err != nil {
		return err
	}
	if _, err := session.ReadSource(path); err != nil {
		return err
	}
	if line < 1 {
		line = 1
	}
	data, err := s.settings.Load()
	if err != nil {
		return err
	}
	command := data.Preferences.EditorCommand
	if len(command) == 0 {
		command = []string{"xdg-open", "{file}"}
		if runtime.GOOS == "darwin" {
			command = []string{"open", "-t", "{file}"}
		}
	}
	args := make([]string, len(command))
	for i, arg := range command {
		args[i] = strings.ReplaceAll(strings.ReplaceAll(arg, "{file}", path), "{line}", strconv.Itoa(line))
	}
	// Argument arrays, never shell interpolation. The configured editor command
	// is explicitly user-owned, not read from the project being debugged.
	cmd := exec.Command(args[0], args[1:]...)
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

func RequestClose(s *Service) bool {
	if s.quitting.Load() || !s.manager.Active() {
		return true
	}
	if s.app != nil {
		s.app.Event.Emit("lantern:close-requested")
	}
	return false
}

func (s *Service) Quit(ctx context.Context) error {
	if s.app == nil {
		return errors.New("desktop is not attached")
	}
	if err := s.manager.Close(ctx); err != nil {
		return err
	}
	s.quitting.Store(true)
	s.app.Quit()
	return nil
}

func Shutdown(s *Service) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	_ = s.manager.Close(ctx)
}

func (s *Service) ChooseProgram(directory bool) (string, error) {
	if s.app == nil {
		return "", errors.New("desktop is not attached")
	}
	return s.app.Dialog.OpenFile().CanChooseDirectories(directory).CanChooseFiles(!directory).PromptForSingleSelection()
}

func (s *Service) CopyText(text string) error {
	if s.app == nil {
		return errors.New("desktop is not attached")
	}
	if len(text) > 1024*1024 {
		return errors.New("clipboard value exceeds 1 MiB")
	}
	if !s.app.Clipboard.SetText(text) {
		return errors.New("the desktop clipboard is unavailable")
	}
	return nil
}
