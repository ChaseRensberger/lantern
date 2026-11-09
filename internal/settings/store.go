// Package settings persists user configuration, never captured program state.
package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"lantern/internal/debugger"
)

type Data struct {
	Version     int                     `json:"version"`
	Launches    []debugger.LaunchConfig `json:"launches"`
	Preferences Preferences             `json:"preferences"`
}

type Preferences struct {
	Theme         string             `json:"theme"`
	Watches       []string           `json:"watches"`
	EditorCommand []string           `json:"editorCommand"`
	Shortcuts     map[string]string  `json:"shortcuts"`
	Layout        map[string]float64 `json:"layout,omitempty"`
}

func (d *Data) normalize() error {
	if d.Version != 1 {
		return errors.New("unsupported settings version")
	}
	if d.Launches == nil {
		d.Launches = []debugger.LaunchConfig{}
	}
	if len(d.Launches) > 256 {
		return errors.New("settings contain more than 256 launch configurations")
	}
	p := &d.Preferences
	if p.Theme == "" {
		p.Theme = "system"
	}
	if p.Theme != "system" && p.Theme != "light" && p.Theme != "dark" {
		return errors.New("invalid appearance setting")
	}
	if p.Watches == nil {
		p.Watches = []string{}
	}
	if p.EditorCommand == nil {
		p.EditorCommand = []string{}
	}
	if p.Shortcuts == nil {
		p.Shortcuts = map[string]string{}
	}
	if len(p.Watches) > 32 {
		return errors.New("settings contain more than 32 watches")
	}
	for _, watch := range p.Watches {
		if len(watch) > 4096 {
			return errors.New("watch expression exceeds 4096 bytes")
		}
	}
	if len(p.EditorCommand) > 0 {
		if strings.TrimSpace(p.EditorCommand[0]) == "" {
			return errors.New("editor executable is empty")
		}
		hasFile := false
		for _, arg := range p.EditorCommand {
			if strings.ContainsRune(arg, 0) {
				return errors.New("invalid editor argument")
			}
			hasFile = hasFile || strings.Contains(arg, "{file}")
		}
		if !hasFile {
			return errors.New("editor command needs a {file} placeholder")
		}
	}
	for _, size := range p.Layout {
		if math.IsNaN(size) || math.IsInf(size, 0) || size < 0 || size > 100 {
			return errors.New("invalid panel layout")
		}
	}
	return nil
}

type Store struct {
	path string
	mu   sync.Mutex
}

func New(path string) *Store { return &Store{path: path} }

func DefaultPath() (string, error) {
	if directory := os.Getenv("LANTERN_CONFIG_DIR"); directory != "" {
		if !filepath.IsAbs(directory) {
			return "", errors.New("LANTERN_CONFIG_DIR must be an absolute path")
		}
		return filepath.Join(directory, "settings.json"), nil
	}
	root, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "lantern", "settings.json"), nil
}

func (s *Store) Load() (Data, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data := Data{Version: 1}
	_ = data.normalize()
	f, err := os.Open(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return data, nil
	}
	if err != nil {
		return data, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, 1024*1024+1))
	if err != nil {
		return data, err
	}
	if len(b) > 1024*1024 {
		return data, errors.New("settings file exceeds 1 MiB")
	}
	if err := json.Unmarshal(b, &data); err != nil {
		return data, fmt.Errorf("could not read settings; the original file has not been changed: %w", err)
	}
	if err := data.normalize(); err != nil {
		return Data{}, fmt.Errorf("invalid settings; the file has not been changed: %w", err)
	}
	return data, nil
}

func (s *Store) Save(data Data) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := data.normalize(); err != nil {
		return err
	}
	b, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	if len(b) > 1024*1024 {
		return errors.New("settings exceed 1 MiB")
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(s.path), ".settings-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err := f.Write(b); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), s.path)
}
