package settings

import (
	"os"
	"path/filepath"
	"testing"

	"lantern/internal/debugger"
)

func TestRoundTripUsesPrivateFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lantern", "settings.json")
	s := New(path)
	data, err := s.Load()
	if err != nil || len(data.Launches) != 0 {
		t.Fatal(data, err)
	}
	data.Launches = []debugger.LaunchConfig{{ID: "one", Name: "service", Env: map[string]string{"PRIVATE_VALUE": "example"}}}
	data.Preferences.Theme = "dark"
	if err := s.Save(data); err != nil {
		t.Fatal(err)
	}
	got, err := s.Load()
	if err != nil || got.Launches[0].Env["PRIVATE_VALUE"] != "example" {
		t.Fatal(got, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("settings permissions: %v", info.Mode())
	}
}

func TestExplicitConfigDirectoryIsPlatformIndependent(t *testing.T) {
	directory := t.TempDir()
	t.Setenv("LANTERN_CONFIG_DIR", directory)
	path, err := DefaultPath()
	if err != nil || path != filepath.Join(directory, "settings.json") {
		t.Fatal(path, err)
	}
	t.Setenv("LANTERN_CONFIG_DIR", "relative")
	if _, err := DefaultPath(); err == nil {
		t.Fatal("accepted a relative config override")
	}
}

func TestInvalidPreferencesAreRejectedWithoutChangingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	s := New(path)
	data, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Save(data); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(path)
	data.Preferences.Theme = "unknown"
	if err := s.Save(data); err == nil {
		t.Fatal("accepted invalid theme")
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("invalid settings replaced the original")
	}
}

func TestNullPreferenceCollectionsAreNormalized(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(path, []byte(`{"version":1,"launches":null,"preferences":{"watches":null,"editorCommand":null,"shortcuts":null}}`), 0600); err != nil {
		t.Fatal(err)
	}
	data, err := New(path).Load()
	if err != nil {
		t.Fatal(err)
	}
	if data.Launches == nil || data.Preferences.Watches == nil || data.Preferences.EditorCommand == nil || data.Preferences.Shortcuts == nil {
		t.Fatal("nullable collections reached the frontend")
	}
}

func TestCorruptFileIsNotOverwrittenOnLoad(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(path, []byte("not json"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := New(path).Load(); err == nil {
		t.Fatal("expected settings error")
	}
	b, _ := os.ReadFile(path)
	if string(b) != "not json" {
		t.Fatal("original changed")
	}
}
