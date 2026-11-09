// Package dapclient provides concurrent, cancellable DAP requests over a stream.
// Unknown events remain readable so adapter extensions do not break a session.
package dapclient

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/google/go-dap"
)

type Message struct {
	Seq        int             `json:"seq"`
	Type       string          `json:"type"`
	Command    string          `json:"command,omitempty"`
	Event      string          `json:"event,omitempty"`
	RequestSeq int             `json:"request_seq,omitempty"`
	Success    bool            `json:"success"`
	Message    string          `json:"message,omitempty"`
	Body       json.RawMessage `json:"body,omitempty"`
	Arguments  any             `json:"arguments,omitempty"`
}

type result struct {
	message Message
	err     error
}

type Client struct {
	conn    net.Conn
	writeMu sync.Mutex
	mu      sync.Mutex
	seq     int
	pending map[int]chan result
	err     error
	done    chan struct{}
	onEvent func(Message)
}

func New(conn net.Conn, onEvent func(Message)) *Client {
	c := &Client{conn: conn, pending: make(map[int]chan result), done: make(chan struct{}), onEvent: onEvent}
	go c.read()
	return c
}

func (c *Client) Done() <-chan struct{} { return c.done }

func (c *Client) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

func (c *Client) Close() { c.fail(net.ErrClosed) }

// Start sends a request without waiting for its response. DAP launch responses
// may arrive only after configurationDone, so launch cannot use a blocking call.
func (c *Client) Start(ctx context.Context, command string, arguments any) (func(any) error, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	c.mu.Lock()
	if c.err != nil {
		err := c.err
		c.mu.Unlock()
		return nil, err
	}
	c.seq++
	seq := c.seq
	ch := make(chan result, 1)
	c.pending[seq] = ch
	c.mu.Unlock()
	if err := c.write(Message{Seq: seq, Type: "request", Command: command, Arguments: arguments}); err != nil {
		c.fail(err)
		return nil, err
	}
	return func(body any) error {
		defer func() {
			c.mu.Lock()
			delete(c.pending, seq)
			c.mu.Unlock()
		}()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case r := <-ch:
			if r.err != nil {
				return r.err
			}
			if r.message.Command != command {
				return fmt.Errorf("DAP response command %q does not match %q", r.message.Command, command)
			}
			if !r.message.Success {
				detail := r.message.Message
				var body dap.ErrorResponseBody
				if json.Unmarshal(r.message.Body, &body) == nil && body.Error != nil && body.Error.Format != "" {
					formatted := body.Error.Format
					for key, value := range body.Error.Variables {
						formatted = strings.ReplaceAll(formatted, "{"+key+"}", value)
					}
					detail += ": " + formatted
				}
				return fmt.Errorf("%s: %s", command, detail)
			}
			if body != nil && len(r.message.Body) > 0 {
				return json.Unmarshal(r.message.Body, body)
			}
			return nil
		}
	}, nil
}

func (c *Client) Call(ctx context.Context, command string, args, body any) error {
	wait, err := c.Start(ctx, command, args)
	if err != nil {
		return err
	}
	return wait(body)
}

func (c *Client) write(m Message) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if err := c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return err
	}
	return dap.WriteBaseMessage(c.conn, b)
}

func (c *Client) read() {
	r := bufio.NewReader(c.conn)
	for {
		b, err := dap.ReadBaseMessage(r)
		if err != nil {
			c.fail(err)
			return
		}
		var m Message
		if err := json.Unmarshal(b, &m); err != nil {
			c.fail(fmt.Errorf("invalid DAP message: %w", err))
			return
		}
		switch m.Type {
		case "response":
			c.mu.Lock()
			ch := c.pending[m.RequestSeq]
			delete(c.pending, m.RequestSeq)
			c.mu.Unlock()
			if ch != nil {
				ch <- result{message: m}
			}
		case "event":
			// The callback must not wait for another DAP request on this reader.
			if c.onEvent != nil {
				c.onEvent(m)
			}
		case "request":
			// No reverse requests are advertised by the client yet.
			c.mu.Lock()
			c.seq++
			seq := c.seq
			c.mu.Unlock()
			if err := c.write(Message{Seq: seq, Type: "response", Command: m.Command, RequestSeq: m.Seq, Message: "Lantern does not support this reverse request"}); err != nil {
				c.fail(err)
				return
			}
		default:
			c.fail(errors.New("invalid DAP message type"))
			return
		}
	}
}

func (c *Client) fail(err error) {
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return
	}
	c.err = err
	pending := c.pending
	c.pending = make(map[int]chan result)
	close(c.done)
	c.mu.Unlock()
	_ = c.conn.Close()
	for _, ch := range pending {
		ch <- result{err: err}
	}
}
