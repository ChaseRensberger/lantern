package debugger

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

type adapter struct {
	cmd  *exec.Cmd
	done chan struct{}
}

// adapterConnection keeps Go-specific launch settings out of the DAP request
// engine. A second adapter can prepare the same shape without changing framing,
// pause identities, stacks, scopes, or variable inspection.
type adapterConnection struct {
	conn      net.Conn
	process   *adapter
	directory string
	adapterID string
	command   string
	arguments map[string]any
}

func prepareGoAdapter(ctx context.Context, config LaunchConfig, output func(string, string)) (adapterConnection, error) {
	result := adapterConnection{adapterID: "go", command: "launch"}
	var err error
	if config.Kind == "endpoint" {
		result.conn, err = connectLoopback(ctx, config.Endpoint)
		result.command = "attach"
		// Delve halts for configuration. Leave resumption to the person.
		result.arguments = map[string]any{"mode": "remote", "stopOnEntry": true, "hideSystemGoroutines": true}
		return result, err
	}
	result.directory, err = sessionDirectory()
	if err != nil {
		return result, err
	}
	result.process, result.conn, err = startDelve(ctx, config, output)
	result.arguments = map[string]any{"mode": config.Mode, "program": config.Program, "cwd": config.Cwd,
		"args": config.Args, "env": config.Env, "buildFlags": config.BuildFlags, "stopOnEntry": config.StopOnEntry,
		"output": filepath.Join(result.directory, "target"), "showGlobalVariables": false, "hideSystemGoroutines": true, "stackTraceDepth": 50}
	return result, err
}

func startDelve(ctx context.Context, config LaunchConfig, output func(string, string)) (*adapter, net.Conn, error) {
	path := config.DelvePath
	if path == "" {
		path = "dlv"
	}
	resolved, err := exec.LookPath(path)
	if err != nil {
		return nil, nil, errors.New("Delve was not found; install dlv or choose its executable in the launch settings")
	}
	cmd := exec.Command(resolved, "dap", "--listen=127.0.0.1:0")
	cmd.Dir = config.Cwd
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = stdout.Close()
		return nil, nil, err
	}
	if err := cmd.Start(); err != nil {
		_ = stdout.Close()
		_ = stderr.Close()
		return nil, nil, err
	}
	a := &adapter{cmd: cmd, done: make(chan struct{})}
	address := make(chan string, 1)
	startupError := make(chan error, 1)
	var readers sync.WaitGroup
	readers.Add(2)
	go func() {
		defer readers.Done()
		r := bufio.NewReaderSize(stdout, 4096)
		line, err := r.ReadSlice('\n')
		if err != nil {
			output("stderr", "Delve did not report its listening address.\n")
			startupError <- errors.New("Delve did not report its listening address")
			return
		}
		const prefix = "DAP server listening at: "
		if !strings.HasPrefix(string(line), prefix) {
			output("stderr", string(line))
			startupError <- errors.New("unexpected Delve startup response; see adapter output")
			return
		}
		address <- strings.TrimSpace(strings.TrimPrefix(string(line), prefix))
		copyOutput(r, "stdout", output)
	}()
	go func() { defer readers.Done(); copyOutput(stderr, "stderr", output) }()
	go func() {
		// Drain pipes before Wait closes them. On shutdown, killing the adapter
		// closes both pipes and allows these goroutines to finish.
		readers.Wait()
		_ = cmd.Wait()
		close(a.done)
	}()
	var addr string
	select {
	case addr = <-address:
	case err := <-startupError:
		a.stop()
		return nil, nil, err
	case <-ctx.Done():
		a.stop()
		return nil, nil, ctx.Err()
	case <-a.done:
		return nil, nil, errors.New("Delve exited before accepting a connection; see adapter output")
	}
	conn, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", addr)
	if err != nil {
		a.stop()
		return nil, nil, fmt.Errorf("connect to Delve: %w", err)
	}
	return a, conn, nil
}

func copyOutput(r io.Reader, category string, output func(string, string)) {
	buffer := make([]byte, 8192)
	for {
		n, err := r.Read(buffer)
		if n > 0 {
			output(category, strings.ToValidUTF8(string(buffer[:n]), "�"))
		}
		if err != nil {
			return
		}
	}
}

func (a *adapter) stop() {
	select {
	case <-a.done:
		return
	default:
	}
	// Give Delve an opportunity to detach/terminate its own target first.
	_ = a.cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-a.done:
		return
	case <-time.After(2 * time.Second):
	}
	_ = a.cmd.Process.Kill()
	select {
	case <-a.done:
	case <-time.After(3 * time.Second):
	}
}

func connectLoopback(ctx context.Context, endpoint string) (net.Conn, error) {
	conn, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", endpoint)
	if err != nil {
		return nil, err
	}
	// Verify the actual peer as well as the configured host. This prevents a
	// modified localhost resolution from opening a remote debug connection.
	peer, ok := conn.RemoteAddr().(*net.TCPAddr)
	if !ok || !peer.IP.IsLoopback() {
		_ = conn.Close()
		return nil, errors.New("debug endpoint did not resolve to loopback")
	}
	return conn, nil
}

func sessionDirectory() (string, error) { return os.MkdirTemp("", "lantern-session-") }
