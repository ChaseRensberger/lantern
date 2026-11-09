//go:build integration

package debugger

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"os"
)

func await(t *testing.T, s *Session, description string, predicate func(Snapshot) bool) Snapshot {
	t.Helper()
	timer := time.NewTimer(90 * time.Second)
	defer timer.Stop()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		snap := s.Snapshot()
		if snap.State == "failed" {
			t.Fatalf("%s: %s\n%+v", description, snap.Error, snap.Output)
		}
		if predicate(snap) {
			return snap
		}
		select {
		case <-timer.C:
			t.Fatalf("timed out waiting for %s: %+v", description, snap)
		case <-ticker.C:
		}
	}
}

func TestDelveServiceInvestigation(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
	program := filepath.Join(root, "examples", "orders")
	source := filepath.Join(program, "main.go")
	b, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	line := 0
	entryLine := 0
	for i, text := range strings.Split(string(b), "\n") {
		if strings.Contains(text, "Try a breakpoint here") {
			line = i + 1
		}
		if strings.Contains(text, "mux := http.NewServeMux()") {
			entryLine = i + 1
		}
	}
	if line == 0 {
		t.Fatal("fixture marker missing")
	}
	m := NewManager()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := m.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	config := LaunchConfig{ID: "orders", Name: "Orders service", Kind: "launch", Mode: "debug", Program: program,
		Breakpoints: map[string][]Breakpoint{source: {{Line: line}, {Line: entryLine}}}}
	initial, err := m.Start(config)
	if err != nil {
		t.Fatal(err)
	}
	s, _ := m.Session(initial.ID)
	stopped := await(t, s, "entry stop", func(s Snapshot) bool { return s.State == "stopped" })
	ref := StopRef{SessionID: initial.ID, Generation: stopped.Generation}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	threads, err := s.Threads(ctx, ref)
	if err != nil || len(threads) == 0 {
		t.Fatalf("threads: %v %v", threads, err)
	}
	if stopped.ThreadID == 0 {
		stopped.ThreadID = threads[0].Id
	}
	frames, err := s.Stack(ctx, ref, stopped.ThreadID)
	if err != nil || len(frames) == 0 {
		t.Fatalf("stack: %v %v", frames, err)
	}
	if _, err := s.ReadSource(frames[0].Source.Path); err != nil {
		t.Fatal(err)
	}
	if !stopped.Breakpoints[source][0].Verified {
		t.Fatalf("breakpoint not verified: %+v", stopped.Breakpoints)
	}
	if _, err := s.SetBreakpoints(ctx, source, []Breakpoint{{Line: line}}); err != nil {
		t.Fatal(err)
	}
	if err := s.Execute(ctx, ref, "continue", stopped.ThreadID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Scopes(ctx, ref, frames[0].Id); err != ErrStaleStop {
		t.Fatalf("stale reference accepted: %v", err)
	}
	addressPattern := regexp.MustCompile(`http://127\.0\.0\.1:\d+/order`)
	var address string
	await(t, s, "service address", func(s Snapshot) bool {
		for _, output := range s.Output {
			if match := addressPattern.FindString(output.Text); match != "" {
				address = match
				return true
			}
		}
		return false
	})
	response := make(chan error, 1)
	go func() {
		client := http.Client{Timeout: 30 * time.Second}
		r, err := client.Get(address)
		if err == nil {
			_, err = io.Copy(io.Discard, r.Body)
			_ = r.Body.Close()
		}
		response <- err
	}()
	paused := await(t, s, "request breakpoint", func(s Snapshot) bool { return s.State == "stopped" && s.Generation > ref.Generation })
	ref = StopRef{SessionID: initial.ID, Generation: paused.Generation}
	frames, err = s.Stack(ctx, ref, paused.ThreadID)
	if err != nil || len(frames) == 0 {
		t.Fatal(frames, err)
	}
	value, err := s.Evaluate(ctx, ref, frames[0].Id, "subtotal")
	if err != nil || value.Result != "0" {
		t.Fatalf("subtotal: %+v %v", value, err)
	}
	scopes, err := s.Scopes(ctx, ref, frames[0].Id)
	if err != nil || len(scopes) == 0 {
		t.Fatal(scopes, err)
	}
	page, err := s.Variables(ctx, ref, scopes[0].VariablesReference, 0)
	if err != nil || len(page.Variables) == 0 {
		t.Fatal(page, err)
	}
	if err := s.Execute(ctx, ref, "next", paused.ThreadID); err != nil {
		t.Fatal(err)
	}
	stepped := await(t, s, "step", func(s Snapshot) bool { return s.State == "stopped" && s.Generation > ref.Generation })
	ref = StopRef{SessionID: initial.ID, Generation: stepped.Generation}
	frames, err = s.Stack(ctx, ref, stepped.ThreadID)
	if err != nil || len(frames) == 0 {
		t.Fatal(frames, err)
	}
	value, err = s.Evaluate(ctx, ref, frames[0].Id, "subtotal")
	if err != nil || value.Result != "2400" {
		t.Fatalf("subtotal after next: %+v %v", value, err)
	}
	// Remove the loop breakpoint so the outstanding request can finish.
	if _, err := s.SetBreakpoints(ctx, source, nil); err != nil {
		t.Fatal(err)
	}
	if err := s.Execute(ctx, ref, "continue", stepped.ThreadID); err != nil {
		t.Fatal(err)
	}
	if err := <-response; err != nil {
		t.Fatal(err)
	}
	second, err := m.Start(config)
	if err != nil {
		t.Fatal(err)
	}
	s2, _ := m.Session(second.ID)
	await(t, s2, "second independent session", func(s Snapshot) bool { return s.State == "stopped" })
	if s.Snapshot().State != "running" {
		t.Fatal("second session changed first session state")
	}
	if len(m.Snapshots()) != 2 {
		t.Fatal("missing independent sessions")
	}
	t.Log(fmt.Sprintf("Verified service request, breakpoint, subtotal 0 -> 2400, and two sessions on %s", runtime.GOOS))
}

func TestDelveGoTestPackage(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	program := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "examples", "orders"))
	source := filepath.Join(program, "main.go")
	b, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	line := 0
	for i, text := range strings.Split(string(b), "\n") {
		if strings.Contains(text, "Try a breakpoint here") {
			line = i + 1
		}
	}
	m := NewManager()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := m.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	initial, err := m.Start(LaunchConfig{Name: "Go test", Kind: "launch", Mode: "test", Program: program, Args: []string{"-test.run", "^TestTotal$"}, Breakpoints: map[string][]Breakpoint{source: {{Line: line}}}})
	if err != nil {
		t.Fatal(err)
	}
	s, _ := m.Session(initial.ID)
	stopped := await(t, s, "test breakpoint", func(s Snapshot) bool { return s.State == "stopped" })
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if _, err := s.SetBreakpoints(ctx, source, nil); err != nil {
		t.Fatal(err)
	}
	if err := s.Execute(ctx, StopRef{SessionID: initial.ID, Generation: stopped.Generation}, "continue", stopped.ThreadID); err != nil {
		t.Fatal(err)
	}
	await(t, s, "test completion", func(s Snapshot) bool { return s.State == "terminated" })
}

func TestDelveEndpointPreservesExternalTarget(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	program := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "examples", "orders"))
	binary := filepath.Join(t.TempDir(), "orders")
	build := exec.Command("go", "build", "-gcflags=all=-N -l", "-o", binary, program)
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build fixture: %v\n%s", err, output)
	}
	cmd := exec.Command("dlv", "--headless", "--listen=127.0.0.1:0", "--accept-multiclient", "exec", binary)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	t.Cleanup(func() {
		_ = cmd.Process.Signal(syscall.SIGTERM)
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
			<-done
		}
	})
	reader := bufio.NewReader(stdout)
	line, err := reader.ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	const prefix = "API server listening at: "
	if !strings.HasPrefix(line, prefix) {
		t.Fatalf("unexpected server output: %s", line)
	}
	endpoint := strings.TrimSpace(strings.TrimPrefix(line, prefix))
	address := make(chan string, 1)
	go func() {
		pattern := regexp.MustCompile(`http://127\.0\.0\.1:\d+/order`)
		for {
			line, err := reader.ReadString('\n')
			if match := pattern.FindString(line); match != "" {
				select {
				case address <- match:
				default:
				}
			}
			if err != nil {
				return
			}
		}
	}()
	m := NewManager()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = m.Close(ctx)
	})
	initial, err := m.Start(LaunchConfig{Name: "External service", Kind: "endpoint", Endpoint: endpoint, Cwd: program})
	if err != nil {
		t.Fatal(err)
	}
	s, _ := m.Session(initial.ID)
	stopped := await(t, s, "remote attach", func(s Snapshot) bool { return s.State == "stopped" })
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := s.Execute(ctx, StopRef{SessionID: initial.ID, Generation: stopped.Generation}, "continue", stopped.ThreadID); err != nil {
		t.Fatal(err)
	}
	var url string
	select {
	case url = <-address:
	case <-ctx.Done():
		t.Fatal("external target did not start")
	}
	if err := s.Disconnect(ctx, false); err != nil {
		t.Fatal(err)
	}
	client := http.Client{Timeout: 3 * time.Second}
	response, err := client.Get(url)
	if err != nil {
		t.Fatalf("external target did not survive disconnect: %v", err)
	}
	_ = response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal(response.Status)
	}
}

func TestDelveLargeCollectionIsPaged(t *testing.T) {
	program := t.TempDir()
	if err := os.WriteFile(filepath.Join(program, "go.mod"), []byte("module lantern-fixture\n\ngo 1.26.0\n"), 0600); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(program, "main.go")
	code := "package main\nimport \"fmt\"\nfunc main(){\nvalues:=make([]int,10000)\nfor i:=range values { values[i]=i }\nfmt.Println(values[0])\n}\n"
	if err := os.WriteFile(source, []byte(code), 0600); err != nil {
		t.Fatal(err)
	}
	m := NewManager()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := m.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	initial, err := m.Start(LaunchConfig{Name: "Large collection", Kind: "launch", Mode: "debug", Program: program, Breakpoints: map[string][]Breakpoint{source: {{Line: 6}}}})
	if err != nil {
		t.Fatal(err)
	}
	s, _ := m.Session(initial.ID)
	paused := await(t, s, "collection breakpoint", func(s Snapshot) bool { return s.State == "stopped" })
	ref := StopRef{SessionID: initial.ID, Generation: paused.Generation}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	frames, err := s.Stack(ctx, ref, paused.ThreadID)
	if err != nil || len(frames) == 0 {
		t.Fatal(frames, err)
	}
	value, err := s.Evaluate(ctx, ref, frames[0].Id, "values")
	if err != nil || value.VariablesReference == 0 {
		t.Fatal(value, err)
	}
	first, err := s.Variables(ctx, ref, value.VariablesReference, 0, "indexed")
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.Variables(ctx, ref, value.VariablesReference, MaxVariables, "indexed")
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Variables) != MaxVariables || len(second.Variables) != MaxVariables || !first.More {
		t.Fatalf("unexpected page sizes: %d %d", len(first.Variables), len(second.Variables))
	}
	if first.Variables[0].Name == second.Variables[0].Name {
		t.Fatal("adapter did not advance the page")
	}
}
