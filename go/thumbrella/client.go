package thumbrella

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type RunRequest struct {
	Prompt   string            `json:"prompt"`
	Metadata map[string]string `json:"metadata,omitempty"`
}

type RunResponse struct {
	RequestID string `json:"requestId"`
	Output    string `json:"output"`
	Model     string `json:"model,omitempty"`
}

type StatusResponse struct {
	OK      bool   `json:"ok"`
	Version string `json:"version,omitempty"`
}

type StreamEvent struct {
	RequestID string `json:"requestId"`
	Type      string `json:"type"`
	Delta     string `json:"delta,omitempty"`
	Done      bool   `json:"done,omitempty"`
	Error     string `json:"error,omitempty"`
}

type Client struct {
	baseURL    string
	apiKey     string
	httpClient *http.Client
}

func NewClient(baseURL, apiKey string) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

func (c *Client) GetStatus(ctx context.Context) (StatusResponse, error) {
	var out StatusResponse
	err := c.requestJSON(ctx, http.MethodGet, "/v1/status", nil, &out)
	return out, err
}

func (c *Client) Run(ctx context.Context, payload RunRequest) (RunResponse, error) {
	var out RunResponse
	err := c.requestJSON(ctx, http.MethodPost, "/v1/run", payload, &out)
	return out, err
}

func (c *Client) RunImageBytes(ctx context.Context, payload RunRequest) ([]byte, error) {
	return c.requestBytes(ctx, http.MethodPost, "/v1/run", payload, "image/jpeg")
}

func (c *Client) Stream(ctx context.Context, payload RunRequest) (<-chan StreamEvent, <-chan error) {
	events := make(chan StreamEvent)
	errs := make(chan error, 1)

	go func() {
		defer close(events)
		defer close(errs)

		body, err := json.Marshal(payload)
		if err != nil {
			errs <- err
			return
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/v1/stream", bytes.NewReader(body))
		if err != nil {
			errs <- err
			return
		}
		req.Header = c.headers()

		resp, err := c.httpClient.Do(req)
		if err != nil {
			errs <- err
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			data, _ := io.ReadAll(resp.Body)
			errs <- fmt.Errorf("stream failed: %s: %s", resp.Status, string(data))
			return
		}

		scanner := bufio.NewScanner(resp.Body)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}

			var event StreamEvent
			if err := json.Unmarshal([]byte(line), &event); err != nil {
				errs <- err
				return
			}

			select {
			case <-ctx.Done():
				errs <- ctx.Err()
				return
			case events <- event:
			}
		}

		if err := scanner.Err(); err != nil {
			errs <- err
		}
	}()

	return events, errs
}

func (c *Client) requestJSON(ctx context.Context, method, path string, in any, out any) error {
	var body io.Reader
	if in != nil {
		data, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return err
	}
	req.Header = c.headers()

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("request failed: %s: %s", resp.Status, string(data))
	}

	return json.NewDecoder(resp.Body).Decode(out)
}

func (c *Client) requestBytes(ctx context.Context, method, path string, in any, accept string) ([]byte, error) {
	var body io.Reader
	if in != nil {
		data, err := json.Marshal(in)
		if err != nil {
			return nil, err
		}
		body = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return nil, err
	}
	req.Header = c.headers()
	if accept != "" {
		req.Header.Set("Accept", accept)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("request failed: %s: %s", resp.Status, string(data))
	}

	return io.ReadAll(resp.Body)
}

func (c *Client) headers() http.Header {
	h := make(http.Header)
	h.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		h.Set("Authorization", "Bearer "+c.apiKey)
	}
	return h
}
