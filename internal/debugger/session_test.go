package debugger

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"lantern/internal/dapclient"
)

func TestRejectNonLoopbackEndpoints(t *testing.T) {
	for _, endpoint := range []string{"0.0.0.0:4000", "example.com:4000", "192.168.1.2:4000", ":4000"} {
		c := LaunchConfig{Name: "test", Kind: "endpoint", Endpoint: endpoint}
		if c.Validate() == nil {
			t.Fatalf("accepted %q", endpoint)
		}
	}
	for _, endpoint := range []string{"127.0.0.1:4000", "[::1]:4000", "localhost:4000"} {
		c := LaunchConfig{Name: "test", Kind: "endpoint", Endpoint: endpoint}
		if err := c.Validate(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestOldPauseCannotInspectAfterContinue(t *testing.T) {
	s := newSession("test", LaunchConfig{})
	defer s.cancel()
	s.snapshot.State = "stopped"
	ref := StopRef{SessionID: "test", Generation: s.snapshot.Generation}
	s.handleEvent(dapclient.Message{Event: "continued"})
	if _, err := s.Threads(context.Background(), ref); err != ErrStaleStop {
		t.Fatal(err)
	}
}

func TestClosingSessionRejectsOtherwiseCurrentPause(t *testing.T) {
	s := newSession("test", LaunchConfig{})
	defer s.cancel()
	s.snapshot.State = "stopped"
	s.client = &dapclient.Client{}
	ref := StopRef{SessionID: "test", Generation: s.snapshot.Generation}
	if _, err := s.atStop(ref); err != nil {
		t.Fatal(err)
	}
	s.closing = true
	if _, err := s.atStop(ref); err != ErrStaleStop {
		t.Fatalf("inspection remained available during disconnect: %v", err)
	}
}

func TestOutputIsBounded(t *testing.T) {
	s := newSession("test", LaunchConfig{})
	defer s.cancel()
	for i := 0; i < 1000; i++ {
		s.appendOutput("stdout", strings.Repeat("x", 8192))
	}
	snapshot := s.Snapshot()
	if !snapshot.OutputDropped || s.outputBytes > 256*1024 || len(snapshot.Output) > 512 {
		t.Fatal("unbounded output")
	}
	snapshot.Output[0].Text = "changed"
	if s.Snapshot().Output[0].Text == "changed" {
		t.Fatal("snapshot aliases live output")
	}
}

func TestEndedSessionCanSavePendingBreakpoints(t *testing.T) {
	s := newSession("test", LaunchConfig{})
	defer s.cancel()
	s.snapshot.State = "terminated"
	path := filepath.Join(t.TempDir(), "main.go")
	items, err := s.SetBreakpoints(context.Background(), path, []Breakpoint{{Line: 27, Verified: true, ID: 8}})
	if err != nil || len(items) != 1 {
		t.Fatal(items, err)
	}
	if items[0].Verified || items[0].ID != 0 || items[0].Message != "Pending next launch" {
		t.Fatal(items)
	}
	if len(s.Snapshot().Breakpoints[path]) != 1 {
		t.Fatal("pending breakpoint was not saved")
	}
}

func TestDisconnectedSessionCanEditPendingBreakpoints(t *testing.T) {
	s := newSession("test", LaunchConfig{})
	s.snapshot.State = "running"
	if err := s.Disconnect(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "main.go")
	items, err := s.SetBreakpoints(context.Background(), path, []Breakpoint{{Line: 27, Verified: true, ID: 8}})
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Verified || items[0].ID != 0 {
		t.Fatal(items)
	}
	if _, err := s.SetBreakpoints(context.Background(), path, nil); err != nil {
		t.Fatal(err)
	}
	if len(s.Snapshot().Breakpoints[path]) != 0 {
		t.Fatal("breakpoint was not removed")
	}
}

func TestSourceBoundsAndSymlinkBoundary(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "main.go")
	if err := os.WriteFile(file, []byte("package main"), 0600); err != nil {
		t.Fatal(err)
	}
	s := newSession("test", LaunchConfig{Cwd: root})
	defer s.cancel()
	first, err := s.ReadSource(file)
	if err != nil || first.Hash == "" {
		t.Fatal(first, err)
	}
	outside := filepath.Join(t.TempDir(), "outside.go")
	if err := os.WriteFile(outside, []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link.go")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReadSource(link); err == nil {
		t.Fatal("followed source symlink outside project")
	}
	if err := os.WriteFile(file, []byte(strings.Repeat("x", MaxSourceBytes+1)), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReadSource(file); err == nil {
		t.Fatal("accepted oversized source")
	}
}
