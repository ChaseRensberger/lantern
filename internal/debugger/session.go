package debugger

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/go-dap"
	"lantern/internal/dapclient"
)

type Session struct {
	mu           sync.Mutex
	life         sync.Mutex
	actions      sync.Mutex
	config       LaunchConfig
	snapshot     Snapshot
	client       *dapclient.Client
	adapter      *adapter
	directory    string
	initialized  chan struct{}
	initOnce     sync.Once
	cleanupOnce  sync.Once
	ctx          context.Context
	cancel       context.CancelFunc
	closing      bool
	outputBytes  int
	outputID     uint64
	knownSources map[string]bool
}

func newSession(id string, config LaunchConfig) *Session {
	ctx, cancel := context.WithCancel(context.Background())
	return &Session{config: config, ctx: ctx, cancel: cancel, initialized: make(chan struct{}), knownSources: make(map[string]bool), snapshot: Snapshot{
		ID: id, Name: config.Name, ConfigID: config.ID, Kind: config.Kind, State: "starting", Generation: 1,
		Breakpoints: cloneBreakpoints(config.Breakpoints), Output: []Output{},
	}}
}

func (s *Session) Snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.snapshot
	out.Breakpoints = cloneBreakpoints(out.Breakpoints)
	out.Output = append([]Output{}, out.Output...)
	return out
}

func (s *Session) bumpRevisionLocked() {
	s.snapshot.Revision++
}

func (s *Session) start(ctx context.Context) error {
	s.life.Lock()
	defer s.life.Unlock()
	connection, err := prepareGoAdapter(ctx, s.config, s.appendOutput)
	s.directory, s.adapter = connection.directory, connection.process
	if err != nil {
		return err
	}
	c := dapclient.New(connection.conn, s.handleEvent)
	s.mu.Lock()
	s.client = c
	s.mu.Unlock()
	go func() {
		<-c.Done()
		s.mu.Lock()
		defer s.mu.Unlock()
		if !s.closing && s.snapshot.State != "terminated" && s.snapshot.State != "failed" {
			s.snapshot.State = "failed"
			s.snapshot.Error = fmt.Sprintf("debug adapter disconnected: %v", c.Err())
			s.snapshot.Generation++
			s.bumpRevisionLocked()
		}
	}()
	var caps dap.Capabilities
	if err := c.Call(ctx, "initialize", map[string]any{
		"clientID": "lantern", "clientName": "Lantern", "adapterID": connection.adapterID, "pathFormat": "path",
		"linesStartAt1": true, "columnsStartAt1": true, "supportsVariableType": true,
		"supportsVariablePaging": true, "supportsRunInTerminalRequest": false,
	}, &caps); err != nil {
		return err
	}
	s.mu.Lock()
	s.snapshot.Capabilities = caps
	s.bumpRevisionLocked()
	s.mu.Unlock()
	waitLaunch, err := c.Start(ctx, connection.command, connection.arguments)
	if err != nil {
		return err
	}
	launchDone := make(chan error, 1)
	go func() { launchDone <- waitLaunch(nil) }()
	launchFinished := false
	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-launchDone:
		if err != nil {
			return err
		}
		launchFinished = true
		select {
		case <-s.initialized:
		case <-ctx.Done():
			return ctx.Err()
		}
	case <-s.initialized:
	}
	for path, items := range s.config.Breakpoints {
		if _, err := s.setBreakpoints(ctx, path, items); err != nil {
			return err
		}
	}
	if caps.SupportsConfigurationDoneRequest {
		if err := c.Call(ctx, "configurationDone", struct{}{}, nil); err != nil {
			return err
		}
	}
	if !launchFinished {
		select {
		case err := <-launchDone:
			if err != nil {
				return err
			}
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	s.mu.Lock()
	if s.snapshot.State == "starting" {
		s.snapshot.State = "running"
		s.bumpRevisionLocked()
	}
	s.mu.Unlock()
	return nil
}

func (s *Session) handleEvent(m dapclient.Message) {
	if m.Event == "initialized" {
		s.initOnce.Do(func() { close(s.initialized) })
		return
	}
	if m.Event == "output" {
		var b struct {
			Category string `json:"category"`
			Output   string `json:"output"`
		}
		if json.Unmarshal(m.Body, &b) == nil {
			s.appendOutput(b.Category, b.Output)
		}
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing && m.Event != "terminated" {
		return
	}
	switch m.Event {
	case "capabilities":
		var body struct {
			Capabilities map[string]json.RawMessage `json:"capabilities"`
		}
		if json.Unmarshal(m.Body, &body) != nil {
			return
		}
		existing, _ := json.Marshal(s.snapshot.Capabilities)
		var merged map[string]json.RawMessage
		if json.Unmarshal(existing, &merged) != nil {
			return
		}
		for key, value := range body.Capabilities {
			merged[key] = value
		}
		combined, _ := json.Marshal(merged)
		if json.Unmarshal(combined, &s.snapshot.Capabilities) != nil {
			return
		}
	case "stopped":
		var b struct {
			Reason      string `json:"reason"`
			Description string `json:"description"`
			Text        string `json:"text"`
			ThreadID    int    `json:"threadId"`
		}
		if err := json.Unmarshal(m.Body, &b); err != nil {
			return
		}
		s.snapshot.State = "stopped"
		s.snapshot.Reason = b.Reason
		if b.Description != "" {
			s.snapshot.Reason += ": " + b.Description
		} else if b.Text != "" {
			s.snapshot.Reason += ": " + b.Text
		}
		s.snapshot.ThreadID = b.ThreadID
		s.snapshot.Generation++
	case "continued":
		s.snapshot.State = "running"
		s.snapshot.Reason = ""
		s.snapshot.Generation++
	case "terminated":
		s.snapshot.State = "terminated"
		s.snapshot.Generation++
	case "breakpoint":
		var b struct {
			Breakpoint dap.Breakpoint `json:"breakpoint"`
		}
		if json.Unmarshal(m.Body, &b) != nil {
			return
		}
		for path, items := range s.snapshot.Breakpoints {
			for i := range items {
				if items[i].ID == b.Breakpoint.Id && b.Breakpoint.Id != 0 {
					items[i].Verified = b.Breakpoint.Verified
					items[i].Message = b.Breakpoint.Message
					if b.Breakpoint.Line > 0 {
						items[i].Line = b.Breakpoint.Line
					}
				}
			}
			s.snapshot.Breakpoints[path] = items
		}
	default:
		return
	}
	s.bumpRevisionLocked()
}

func (s *Session) appendOutput(category, text string) {
	if text == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	text = strings.ToValidUTF8(text, "�")
	if len(text) > 16*1024 {
		text = strings.ToValidUTF8(text[:16*1024], "�") + "\n[output chunk truncated]\n"
	}
	s.outputID++
	s.snapshot.Output = append(s.snapshot.Output, Output{ID: s.outputID, Category: category, Text: text})
	s.outputBytes += len(text)
	for len(s.snapshot.Output) > 512 || s.outputBytes > 256*1024 {
		s.outputBytes -= len(s.snapshot.Output[0].Text)
		s.snapshot.Output = s.snapshot.Output[1:]
		s.snapshot.OutputDropped = true
	}
	s.bumpRevisionLocked()
}

func (s *Session) fail(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return
	}
	s.snapshot.State = "failed"
	s.snapshot.Error = err.Error()
	s.snapshot.Generation++
	s.bumpRevisionLocked()
}

func (s *Session) atStop(ref StopRef) (*dapclient.Client, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing || ref.SessionID != s.snapshot.ID || ref.Generation != s.snapshot.Generation || s.snapshot.State != "stopped" || s.client == nil {
		return nil, ErrStaleStop
	}
	return s.client, nil
}

func (s *Session) inspect(ctx context.Context, ref StopRef, command string, args, result any) error {
	// Check the pause identity and put the request on the wire in the same
	// execution-action critical section. A Continue cannot overtake this check
	// and send an old variable handle after the target has resumed.
	s.actions.Lock()
	c, err := s.atStop(ref)
	if err != nil {
		s.actions.Unlock()
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, RequestTimeoutSeconds*time.Second)
	defer cancel()
	wait, err := c.Start(ctx, command, args)
	s.actions.Unlock()
	if err != nil {
		return err
	}
	if err := wait(result); err != nil {
		return err
	}
	_, err = s.atStop(ref)
	return err
}

func (s *Session) Threads(ctx context.Context, ref StopRef) ([]dap.Thread, error) {
	var body struct {
		Threads []dap.Thread `json:"threads"`
	}
	err := s.inspect(ctx, ref, "threads", struct{}{}, &body)
	if body.Threads == nil {
		body.Threads = []dap.Thread{}
	}
	return body.Threads, err
}

func (s *Session) Stack(ctx context.Context, ref StopRef, threadID int) ([]dap.StackFrame, error) {
	var body struct {
		Frames []dap.StackFrame `json:"stackFrames"`
	}
	err := s.inspect(ctx, ref, "stackTrace", map[string]int{"threadId": threadID, "startFrame": 0, "levels": 50}, &body)
	if body.Frames == nil {
		body.Frames = []dap.StackFrame{}
	}
	if err == nil {
		s.mu.Lock()
		for _, frame := range body.Frames {
			if frame.Source != nil && frame.Source.Path != "" {
				s.knownSources[filepath.Clean(frame.Source.Path)] = true
			}
		}
		s.mu.Unlock()
	}
	return body.Frames, err
}

func (s *Session) Scopes(ctx context.Context, ref StopRef, frameID int) ([]dap.Scope, error) {
	var body struct {
		Scopes []dap.Scope `json:"scopes"`
	}
	err := s.inspect(ctx, ref, "scopes", map[string]int{"frameId": frameID}, &body)
	if body.Scopes == nil {
		body.Scopes = []dap.Scope{}
	}
	return body.Scopes, err
}

func (s *Session) Variables(ctx context.Context, ref StopRef, reference, start int, filters ...string) (VariablePage, error) {
	if reference <= 0 || start < 0 {
		return VariablePage{}, errors.New("invalid variable reference or page")
	}
	var body struct {
		Variables []dap.Variable `json:"variables"`
	}
	filter := ""
	if len(filters) > 0 {
		filter = filters[0]
	}
	if filter != "" && filter != "indexed" && filter != "named" {
		return VariablePage{}, errors.New("invalid variable filter")
	}
	err := s.inspect(ctx, ref, "variables", map[string]any{"variablesReference": reference, "start": start, "count": MaxVariables, "filter": filter}, &body)
	more := len(body.Variables) >= MaxVariables
	if len(body.Variables) > MaxVariables {
		body.Variables = body.Variables[:MaxVariables]
	}
	if body.Variables == nil {
		body.Variables = []dap.Variable{}
	}
	for i := range body.Variables {
		if len(body.Variables[i].Value) > 16*1024 {
			body.Variables[i].Value = strings.ToValidUTF8(body.Variables[i].Value[:16*1024], "�") + " [truncated]"
		}
	}
	return VariablePage{Variables: body.Variables, More: more}, err
}

func (s *Session) Evaluate(ctx context.Context, ref StopRef, frameID int, expression string) (dap.EvaluateResponseBody, error) {
	if strings.TrimSpace(expression) == "" || len(expression) > 4096 {
		return dap.EvaluateResponseBody{}, errors.New("enter an expression of at most 4096 bytes")
	}
	// Delve function calls require its special call command. This app exposes
	// watch evaluation, not a debugger command console or a mutation endpoint.
	if strings.HasPrefix(strings.TrimSpace(expression), "call ") {
		return dap.EvaluateResponseBody{}, errors.New("function calls are not enabled")
	}
	var body dap.EvaluateResponseBody
	err := s.inspect(ctx, ref, "evaluate", map[string]any{"frameId": frameID, "expression": expression, "context": "watch"}, &body)
	return body, err
}

func (s *Session) Execute(ctx context.Context, ref StopRef, command string, threadID int) error {
	s.actions.Lock()
	defer s.actions.Unlock()
	if command != "continue" && command != "next" && command != "stepIn" && command != "stepOut" && command != "pause" {
		return errors.New("unsupported execution command")
	}
	s.mu.Lock()
	c := s.client
	if c == nil || s.closing || ref.SessionID != s.snapshot.ID {
		s.mu.Unlock()
		return errors.New("session is not connected")
	}
	if command == "pause" {
		if s.snapshot.State != "running" {
			s.mu.Unlock()
			return errors.New("program is not running")
		}
	} else if s.snapshot.State != "stopped" || s.snapshot.Generation != ref.Generation {
		s.mu.Unlock()
		return ErrStaleStop
	}
	previousState := s.snapshot.State
	// Invalidate references before writing, not when the eventual continued
	// event arrives. Outstanding inspections cannot replace a newer pause.
	s.snapshot.Generation++
	generation := s.snapshot.Generation
	if command != "pause" {
		s.snapshot.State = "running"
		s.snapshot.Reason = ""
	}
	s.bumpRevisionLocked()
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, RequestTimeoutSeconds*time.Second)
	defer cancel()
	err := c.Call(ctx, command, map[string]int{"threadId": threadID}, nil)
	if err != nil {
		s.mu.Lock()
		if s.snapshot.Generation == generation {
			s.snapshot.State = previousState
			s.snapshot.Generation++
			s.bumpRevisionLocked()
		}
		s.mu.Unlock()
	}
	return err
}

func (s *Session) SetBreakpoints(ctx context.Context, path string, items []Breakpoint) ([]Breakpoint, error) {
	s.actions.Lock()
	defer s.actions.Unlock()
	s.mu.Lock()
	state := s.snapshot.State
	if s.closing && state != "disconnected" && state != "terminated" && state != "failed" {
		s.mu.Unlock()
		return nil, errors.New("session is disconnecting")
	}
	if state == "starting" {
		s.mu.Unlock()
		return nil, errors.New("wait for the target to start before changing breakpoints")
	}
	if state == "terminated" || state == "disconnected" || state == "failed" {
		if !filepath.IsAbs(path) || len(items) > 1000 {
			s.mu.Unlock()
			return nil, errors.New("invalid breakpoint source or too many breakpoints")
		}
		pending := sortedLines(items)
		for i := range pending {
			if pending[i].Line < 1 {
				s.mu.Unlock()
				return nil, errors.New("breakpoint lines start at 1")
			}
			pending[i].Verified = false
			pending[i].ID = 0
			pending[i].Message = "Pending next launch"
		}
		s.snapshot.Breakpoints[path] = pending
		s.bumpRevisionLocked()
		s.mu.Unlock()
		return append([]Breakpoint{}, pending...), nil
	}
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, RequestTimeoutSeconds*time.Second)
	defer cancel()
	return s.setBreakpoints(ctx, path, items)
}

func (s *Session) setBreakpoints(ctx context.Context, path string, items []Breakpoint) ([]Breakpoint, error) {
	if !filepath.IsAbs(path) || len(items) > 1000 {
		return nil, errors.New("invalid breakpoint source or too many breakpoints")
	}
	s.mu.Lock()
	c := s.client
	caps := s.snapshot.Capabilities
	s.mu.Unlock()
	if c == nil {
		return nil, errors.New("session is not connected")
	}
	points := make([]dap.SourceBreakpoint, 0, len(items))
	items = sortedLines(items)
	for _, item := range items {
		if item.Line < 1 {
			return nil, errors.New("breakpoint lines start at 1")
		}
		if item.Condition != "" && !caps.SupportsConditionalBreakpoints {
			return nil, errors.New("adapter does not support conditional breakpoints")
		}
		if item.HitCondition != "" && !caps.SupportsHitConditionalBreakpoints {
			return nil, errors.New("adapter does not support hit counts")
		}
		if item.LogMessage != "" && !caps.SupportsLogPoints {
			return nil, errors.New("adapter does not support logpoints")
		}
		points = append(points, dap.SourceBreakpoint{Line: item.Line, Condition: item.Condition, HitCondition: item.HitCondition, LogMessage: item.LogMessage})
	}
	var body struct {
		Breakpoints []dap.Breakpoint `json:"breakpoints"`
	}
	if err := c.Call(ctx, "setBreakpoints", map[string]any{"source": dap.Source{Path: path}, "breakpoints": points}, &body); err != nil {
		return nil, err
	}
	for i := range items {
		items[i].Verified = false
		items[i].Message = "Adapter did not return a verification result"
		if i < len(body.Breakpoints) {
			bp := body.Breakpoints[i]
			items[i].Verified, items[i].Message, items[i].ID = bp.Verified, bp.Message, bp.Id
			if bp.Line > 0 {
				items[i].Line = bp.Line
			}
		}
	}
	s.mu.Lock()
	s.snapshot.Breakpoints[path] = items
	s.bumpRevisionLocked()
	s.mu.Unlock()
	return items, nil
}

func (s *Session) Disconnect(ctx context.Context, terminate bool) error {
	s.mu.Lock()
	starting := s.snapshot.State == "starting"
	if starting {
		s.closing = true
		s.cancel()
	}
	s.mu.Unlock()
	s.life.Lock()
	defer s.life.Unlock()
	s.actions.Lock()
	defer s.actions.Unlock()
	s.mu.Lock()
	c := s.client
	state := s.snapshot.State
	s.closing = true
	s.snapshot.State = "disconnecting"
	s.snapshot.Generation++
	s.bumpRevisionLocked()
	s.mu.Unlock()
	var err error
	if c != nil && state != "terminated" && state != "failed" && state != "disconnected" {
		ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err = c.Call(ctx, "disconnect", map[string]bool{"terminateDebuggee": terminate}, nil)
		cancel()
	}
	if err != nil && s.config.Kind == "endpoint" && !starting {
		s.mu.Lock()
		s.closing = false
		s.snapshot.State = state
		if c.Err() != nil {
			s.snapshot.State = "failed"
		}
		s.snapshot.Error = "Disconnect was not acknowledged; target state is unknown: " + err.Error()
		s.snapshot.Generation++
		s.bumpRevisionLocked()
		s.mu.Unlock()
		return fmt.Errorf("disconnect was not acknowledged; target state is unknown: %w", err)
	}
	s.cleanupLocked()
	s.mu.Lock()
	s.snapshot.State = "disconnected"
	s.snapshot.Generation++
	if err != nil {
		s.snapshot.Error = "Adapter shutdown required forced cleanup: " + err.Error()
	}
	s.bumpRevisionLocked()
	s.mu.Unlock()
	return nil
}

func (s *Session) cleanup() { s.life.Lock(); defer s.life.Unlock(); s.cleanupLocked() }

func (s *Session) cleanupLocked() {
	s.cleanupOnce.Do(func() {
		s.cancel()
		s.mu.Lock()
		c := s.client
		s.mu.Unlock()
		if c != nil {
			c.Close()
		}
		if s.adapter != nil {
			s.adapter.stop()
		}
		if s.directory != "" {
			_ = os.RemoveAll(s.directory)
		}
	})
}
