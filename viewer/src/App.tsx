import { Route, Routes } from "react-router-dom"

import { RunList } from "@/components/RunList"
import { RunView } from "@/components/RunView"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"

function Empty() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
      <img src="/icon.svg" alt="" className="size-10 rounded-lg opacity-90" />
      <span className="text-sm">Select a run to view its phase tree.</span>
    </div>
  )
}

export function App() {
  return (
    <div className="h-screen w-screen overflow-hidden">
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel defaultSize="20%" minSize="15%" maxSize="34%">
          <RunList />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize="80%">
          <Routes>
            <Route path="/" element={<Empty />} />
            <Route path="/run/:id" element={<RunView />} />
            <Route path="/run/:id/agent/:index" element={<RunView />} />
          </Routes>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}

export default App
