:- use_module(library(http/json)).
:- use_module(library(lists)).
:- table value/3.

% El tablero es una lista de nueve átomos: 'X', 'O' o e.
line([0,1,2]). line([3,4,5]). line([6,7,8]).
line([0,3,6]). line([1,4,7]). line([2,5,8]).
line([0,4,8]). line([2,4,6]).
winner(B,P) :- line(Is), maplist(cell(B,P),Is).
cell(B,P,I) :- nth0(I,B,P), P \= e.
other('O','X'). other('X','O').
move(B,P,I,N) :- nth0(I,B,e,Rest), nth0(I,N,P,Rest).
value(B,_,10) :- winner(B,'O'), !.
value(B,_,-10) :- winner(B,'X'), !.
value(B,_,0) :- \+ member(e,B), !.
value(B,P,V) :- other(P,Q), findall(S,(move(B,P,_,N),value(N,Q,S)),Scores),
    (P='O' -> max_list(Scores,V) ; min_list(Scores,V)).
% Preferencia determinista: centro, esquinas, bordes; siempre prevalece minimax.
preference([4,0,2,6,8,1,3,5,7]).
best_move(B,I,S) :- preference(Order),
    findall(V-J,(member(J,Order),move(B,'O',J,N),value(N,'X',V)),Options),
    findall(V,member(V-_,Options),Scores), max_list(Scores,S), member(S-I,Options), !.
main :- catch((json_read_dict(current_input,D), maplist(atom_string,B,D.board),
    length(B,9), maplist(valid_cell,B), \+ winner(B,'X'), \+ winner(B,'O'),
    best_move(B,I,S), json_write_dict(current_output,_{index:I,score:S,algorithm:"minimax"}),nl),
    _,halt(1)).
valid_cell(e). valid_cell('X'). valid_cell('O').
