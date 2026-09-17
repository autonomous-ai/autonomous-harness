#set document(title: [Title of the document])
#set page(paper: "a4", margin: 2.2cm)
#set text(font: "Helvetica Neue", size: 11pt)
#set heading(numbering: "1.")

#align(center)[
  #text(size: 26pt, weight: 700)[Title of the document]
  #v(4pt)
  #text(size: 12pt, fill: luma(90))[One line on what it is for, and who it is for.]
]
#v(14pt)

= What this is

A Typst document. Tell the agent what you need — a paper, a spec sheet, a report, a letter — and it
rewrites this file. The pane beside the terminal shows the PDF on every save.

= A table, because most documents have one

#table(
  columns: (auto, 1fr, auto),
  align: (left, left, right),
  table.header([*Part*], [*What it does*], [*Qty*]),
  [Bracket], [Holds the tube to the wall], [2],
  [M5 bolt], [Through the bracket into the stud], [4],
)
