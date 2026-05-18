# Thumbrella Go Client

Lightweight Go wrapper for the Thumbrella HTTP API.

Designed as a fast on-ramp for projects that need API-backed thumbnail and image transform workflows.

## Usage

```go
package main

import (
    "context"
    "fmt"

    th "github.com/thumbrella/thumbrella-clients/go/thumbrella"
)

func main() {
    ctx := context.Background()
    client := th.NewClient("https://api.example.com", "")

    status, _ := client.GetStatus(ctx)
    fmt.Println(status.OK)

    result, _ := client.Run(ctx, th.RunRequest{Prompt: "Hello"})
    fmt.Println(result.Output)

    imageBytes, _ := client.RunImageBytes(ctx, th.RunRequest{Prompt: "Generate thumbnail"})
    fmt.Println(len(imageBytes))

    events, errs := client.Stream(ctx, th.RunRequest{Prompt: "Stream this"})
    for event := range events {
        if event.Delta != "" {
            fmt.Print(event.Delta)
        }
    }

    if err := <-errs; err != nil {
        fmt.Println("stream error:", err)
    }
}
```

## License

Apache-2.0.
