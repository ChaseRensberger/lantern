// Package debugger owns debug sessions without depending on a desktop shell.
package debugger

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/go-dap"
)

const (
	RequestTimeoutSeconds = 15
	MaxVariables          = 100
	MaxSourceBytes        = 1024 * 1024
)

type LaunchConfig struct {
	ID          string                  `json:"id"`
	Name        string                  `json:"name"`
	Kind        string                  `json:"kind"` // launch or endpoint
	Mode        string                  `json:"mode"` // debug, test, exec
	Program     string                  `json:"program"`
	Cwd         string                  `json:"cwd"`
	Args        []string                `json:"args"`
	Env         map[string]string       `json:"env"`
	BuildFlags  string                  `json:"buildFlags"`
	Endpoint    string                  `json:"endpoint"`
	DelvePath   string                  `json:"delvePath"`
	StopOnEntry bool                    `json:"stopOnEntry"`
	Breakpoints map[string][]Breakpoint `json:"breakpoints"`
}

func (c *LaunchConfig) Validate() error {
	c.Name = strings.TrimSpace(c.Name)
	if c.Name == "" {
		return errors.New("give the session a name")
	}
	if c.Kind == "endpoint" {
		host, port, err := net.SplitHostPort(c.Endpoint)
		if err != nil || port == "" {
			return errors.New("enter a loopback endpoint such as 127.0.0.1:38697")
		}
		ip := net.ParseIP(host)
		if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			return errors.New("only loopback endpoints are supported; use an SSH tunnel for remote targets")
		}
		return nil
	}
	if c.Kind != "launch" {
		return errors.New("choose launch or endpoint")
	}
	if c.Mode != "debug" && c.Mode != "test" && c.Mode != "exec" {
		return errors.New("choose package, test, or executable mode")
	}
	if !filepath.IsAbs(c.Program) {
		return errors.New("program must be an absolute package directory or executable path")
	}
	info, err := os.Stat(c.Program)
	if err != nil {
		return fmt.Errorf("program: %w", err)
	}
	if c.Mode != "exec" && !info.IsDir() {
		return errors.New("package and test modes require a directory")
	}
	if c.Cwd == "" {
		c.Cwd = c.Program
		if !info.IsDir() {
			c.Cwd = filepath.Dir(c.Program)
		}
	}
	if !filepath.IsAbs(c.Cwd) {
		return errors.New("working directory must be absolute")
	}
	if info, err := os.Stat(c.Cwd); err != nil || !info.IsDir() {
		return errors.New("working directory does not exist")
	}
	for key, value := range c.Env {
		if key == "" || strings.ContainsAny(key, "=\x00") || strings.ContainsRune(value, 0) {
			return errors.New("invalid environment variable")
		}
	}
	return nil
}

type Breakpoint struct {
	Line         int    `json:"line"`
	Condition    string `json:"condition"`
	HitCondition string `json:"hitCondition"`
	LogMessage   string `json:"logMessage"`
	Verified     bool   `json:"verified"`
	Message      string `json:"message"`
	ID           int    `json:"id"`
}

type Output struct {
	ID       uint64 `json:"id"`
	Category string `json:"category"`
	Text     string `json:"text"`
}

type Snapshot struct {
	ID            string                  `json:"id"`
	Name          string                  `json:"name"`
	ConfigID      string                  `json:"configId"`
	Kind          string                  `json:"kind"`
	State         string                  `json:"state"`
	Reason        string                  `json:"reason"`
	Error         string                  `json:"error"`
	ThreadID      int                     `json:"threadId"`
	Generation    uint64                  `json:"generation"`
	Revision      uint64                  `json:"revision"`
	Capabilities  dap.Capabilities        `json:"capabilities"`
	Breakpoints   map[string][]Breakpoint `json:"breakpoints"`
	Output        []Output                `json:"output"`
	OutputDropped bool                    `json:"outputDropped"`
}

type StopRef struct {
	SessionID  string `json:"sessionId"`
	Generation uint64 `json:"generation"`
}

type VariablePage struct {
	Variables []dap.Variable `json:"variables"`
	More      bool           `json:"more"`
}

type SourceFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Hash    string `json:"hash"`
}

var ErrStaleStop = errors.New("this pause is no longer current")
